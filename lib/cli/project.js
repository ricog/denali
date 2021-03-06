import fs from 'fs';
import path from 'path';
import dedent from 'dedent-js';
import nsp from 'nsp';
import broccoli from 'broccoli';
import rimraf from 'rimraf';
import printSlowNodes from 'broccoli-slow-trees';
import { sync as copyDereferenceSync } from 'copy-dereference';
import chalk from 'chalk';
import MergeTree from 'broccoli-merge-trees';
import Funnel from 'broccoli-funnel';
import createDebug from 'debug';
import noop from 'lodash/noop';
import after from 'lodash/after';
import dropWhile from 'lodash/dropWhile';
import takeWhile from 'lodash/takeWhile';
import semver from 'semver';
import ui from './ui';
import Builder from './builder';
import Watcher from './watcher';
import tryRequire from '../utils/try-require';
import startTimer from '../utils/timer';
import spinner from '../utils/spinner';
import DenaliObject from '../metal/object';

const debug = createDebug('denali:project');

export default class Project extends DenaliObject {

  builders = new Map();

  constructor(options = {}) {
    super();
    this.dir = options.dir || process.cwd();
    debug(`creating project for ${ this.dir }`);
    this.environment = options.environment || 'development';
    this.printSlowTrees = options.printSlowTrees || false;
    this.pkg = require(path.join(this.dir, 'package.json'));
    this.lint = options.lint;
    this.audit = options.audit;
    this.buildDummy = options.buildDummy;
    this.pkg = require(path.join(this.dir, 'package.json'));
  }

  get isAddon() {
    return this.pkg.keywords && this.pkg.keywords.includes('denali-addon');
  }

  getBuilderAndTree() {
    let rootBuilder = this.rootBuilder = Builder.createFor(this.dir, this);
    let rootTree = rootBuilder.toTree();

    if (this.isAddon && this.buildDummy) {
      rootTree = this.buildDummyTree(rootTree);
    }

    let broccoliBuilder = new broccoli.Builder(rootTree);
    function onExit() {
      broccoliBuilder.cleanup();
      process.exit(1);
    }
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);

    debug(`building ${ this.pkg.name }`);
    return {
      builder: rootBuilder,
      tree: rootTree,
      broccoliBuilder
    };
  }

  buildDummyTree(rootTree) {
    debug(`building ${ this.pkg.name }'s dummy app`);
    let dummyBuilder = Builder.createFor(path.join(this.dir, 'test', 'dummy'), this, [ this.dir ]);
    let dummyTree = dummyBuilder.toTree();
    let addonTests = new Funnel(rootTree, {
      include: [ 'test/**/*' ],
      exclude: [ 'test/dummy/**/*' ]
    });
    rootTree = new Funnel(rootTree, {
      exclude: [ 'test/**/*' ],
      destDir: path.join('node_modules', this.pkg.name)
    });
    return new MergeTree([ rootTree, dummyTree, addonTests ], { overwrite: true });
  }

  async build(outputDir = 'dist') {
    debug('building project');
    let { broccoliBuilder } = this.getBuilderAndTree();
    spinner.start(`Building ${ this.pkg.name }`);
    let timer = startTimer();
    try {
      let results = await broccoliBuilder.build();
      this.finishBuild(results, outputDir);
      spinner.succeed(`${ this.pkg.name } build complete (${ timer.stop() }s)`);
    } catch (err) {
      ui.error('');
      if (err.file) {
        ui.error(`File: ${ err.file }`);
      }
      ui.error(err.stack);
      spinner.fail('Build failed');
      throw err;
    } finally {
      await broccoliBuilder.cleanup();
    }
    return outputDir;
  }

  watch({ outputDir = 'dist', onBuild = noop, beforeRebuild }) {
    // Start watcher
    let timer = startTimer();
    let { broccoliBuilder, builder } = this.getBuilderAndTree();
    spinner.start(`Building ${ this.pkg.name }`);
    let watcher = new Watcher(broccoliBuilder, { beforeRebuild, interval: 100 });

    // Watch/build any child addons under development
    let inDevelopmentAddons = builder.childBuilders.filter((childBuilder) => {
      return childBuilder.isDevelopingAddon && fs.lstatSync(childBuilder.dir).isSymbolicLink();
    });
    // Don't finalize the first build until all the in-dev addons have built too
    onBuild = after(inDevelopmentAddons.length, onBuild);
    // Build the in-dev child addons
    inDevelopmentAddons.forEach((childBuilder) => {
      let addonDist = fs.realpathSync(childBuilder.dir);
      debug(`"${ childBuilder.pkg.name }" (${ addonDist }) addon is under development, creating a project to watch & compile it`);
      let addonPackageDir = path.dirname(addonDist);
      let addonProject = new Project({
        environment: this.environment,
        dir: addonPackageDir,
        lint: this.lint,
        audit: this.audit
      });
      addonProject.watch({ onBuild, outputDir: addonDist });
    });

    // Handle watcher events
    watcher.on('buildstart', () => {
      debug('changes detected, rebuilding');
      spinner.start(`Building ${ this.pkg.name }`);
      timer = startTimer();
    });
    watcher.on('change', (results) => {
      debug('rebuild finished, wrapping up');
      this.finishBuild(results, outputDir);
      spinner.succeed(`${ this.pkg.name } build complete (${ timer.stop() }s)`);
      onBuild(this);
    });
    watcher.on('error', (error) => {
      spinner.fail('Build failed');
      if (error.file) {
        if (error.line && error.column) {
          ui.error(`File: ${ error.treeDir }/${ error.file }:${ error.line }:${ error.column }`);
        } else {
          ui.error(`File: ${ error.treeDir }/${ error.file }`);
        }
      }
      if (error.message) {
        ui.error(`Error: ${ error.message }`);
      }
      if (error.stack) {
        ui.error(`Stack trace:\n${ error.stack.replace(/(^.)/mg, '  $1') }`);
      }
    });
  }

  async createApplication() {
    try {
      let outputDir = await this.build();
      let applicationPath = path.resolve(path.join(outputDir, 'app', 'application'));
      let Application = tryRequire(applicationPath);
      if (!Application) {
        throw new Error(`Denali was unable to load app/application.js from ${ applicationPath }`);
      }
      return new Application({
        dir: path.resolve(outputDir),
        environment: this.environment
      });
    } catch (error) {
      ui.error(error.stack);
      throw error;
    }
  }

  finishBuild(results, outputDir) {
    // Copy the result out of broccoli tmp
    if (!path.isAbsolute(outputDir)) {
      outputDir = path.join(process.cwd(), outputDir);
    }
    rimraf.sync(outputDir);
    copyDereferenceSync(results.directory, outputDir);

    // Print slow build trees
    if (this.printSlowTrees) {
      printSlowNodes(results.graph);
    }

    // Run an nsp audit on the package
    if (this.audit) {
      this.auditPackage();
    }
  }

  auditPackage() {
    let pkg = path.join(this.dir, 'package.json');
    nsp.check({ package: pkg }, (err, vulnerabilities) => {
      if (err && [ 'ENOTFOUND', 'ECONNRESET' ].includes(err.code)) {
        ui.warn('Error trying to scan package dependencies for vulnerabilities with nsp, unable to reach server. Skipping scan ...');
        ui.warn(err);
      }
      if (vulnerabilities && vulnerabilities.length > 0) {
        vulnerabilities = this.filterIgnoredVulnerabilities(vulnerabilities, this.rootBuilder.ignoreVulnerabilities);
        if (vulnerabilities.length > 0) {
          ui.warn('WARNING: Some packages in your package.json may have security vulnerabilities:');
          vulnerabilities.map(this.printVulnerability);
        }
      }
    });
  }

  filterIgnoredVulnerabilities(vulnerabilities, ignorePatterns) {
    return vulnerabilities.filter((vulnerability) => {
      return !ignorePatterns.find((ignorePattern) => {
        let ignorePatternPath = ignorePattern.split(' > ');
        let ignorePatternStart = ignorePatternPath[0].split('@');
        let potentialMatch = dropWhile(vulnerability.path, (dependency) => {
          let [ name, version ] = dependency.split('@');
          return !(name === ignorePatternStart[0] && semver.satisfies(version, ignorePatternStart[1]));
        });
        let matchingSequence = takeWhile(potentialMatch, (dependency, i) => {
          let [ name, version ] = dependency.split('@');
          if (!ignorePatternPath[i]) {
            return false;
          }
          let ignorePatternPart = ignorePatternPath[i].split('@');
          return name === ignorePatternPart[0] && semver.satisfies(version, ignorePatternPart[1]);
        });
        return potentialMatch.length > 0 && matchingSequence.length === ignorePatternPath.length;
      });
    });
  }

  printVulnerability(vulnerability) {
    let dependencyPath = vulnerability.path.join(' => ');
    let module = `*** ${ vulnerability.module }@${ vulnerability.version } ***`;
    let recommendation = (vulnerability.recommendation || '').replace(/\n/g, ' ');
    let message = dedent`${ chalk.bold.yellow(module) }
                          Found in: ${ dependencyPath }
                          Recommendation: ${ chalk.reset.cyan(recommendation) }`;
    ui.raw('warn', `${ message }\n`);
  }

}
