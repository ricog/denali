import fs from 'fs';
import path from 'path';
import dedent from 'dedent-js';
import { spawn } from 'child_process';
import ui from '../lib/cli/ui';
import Command from '../lib/cli/command';
import Project from '../lib/cli/project';
import assign from 'lodash/assign';
import createDebug from 'debug';

const debug = createDebug('denali:commands:server');

export default class ServerCommand extends Command {

  static commandName = 'server';
  static description = 'Runs the denali server for local or production use.';
  static longDescription = dedent`
    Launches the Denali server running your application.

    In a development environment, the server does several things:

     * watches your local filesystem for changes and automatically restarts for you.
     * lint your code on build
     * run a security audit of your package.json on build (via nsp)

    In production, the above features are disabled by default, and instead:

     * the server will fork worker processes to maximize CPU core usage`;

  runsInApp = true;

  params = [];

  flags = {
    debug: {
      description: 'Run in debug mode (add the --debug flag to node, launch node-inspector)',
      defaultValue: false,
      type: Boolean
    },
    watch: {
      description: 'Restart the server when the source files change (default: true in development)',
      defaultValue: null,
      type: Boolean
    },
    port: {
      description: 'The port the HTTP server should bind to (default: 3000)',
      defaultValue: 3000,
      type: Number
    },
    lint: {
      description: 'Lint the app source files (default: true in development)',
      defaultValue: null,
      type: Boolean
    },
    audit: {
      description: 'Auditing your package.json for vulnerabilites (default: true in development)',
      defaultValue: null,
      type: Boolean
    },
    output: {
      description: 'The directory to write the compiled app to. Defaults to a tmp directory',
      defaultValue: 'dist',
      type: String
    },
    production: {
      description: 'Start the server in production mode: skip the build (assumes the app was prebuilt), skips nsp audits, runs with DENALI_ENV=production',
      defaultValue: false,
      type: Boolean
    },
    'print-slow-trees': {
      description: 'Print out an analysis of the build process, showing the slowest nodes.',
      defaultValue: false,
      type: Boolean
    }
  }

  run({ flags }) {
    debug('running server command');
    this.environment = flags.production ? 'production' : process.env.DENALI_ENV || process.env.NODE_ENV || 'development';
    this.watch = flags.watch || this.environment === 'development';
    this.port = flags.port;
    this.debug = flags.debug;

    if (this.environment === 'production') {
      return this.startServer(flags.output);
    }

    this.project = new Project({
      environment: this.environment,
      printSlowTrees: flags['print-slow-trees'],
      audit: flags.audit || this.environment === 'development',
      lint: flags.lint || this.environment !== 'production',
      buildDummy: true
    });

    process.on('exit', this.cleanExit.bind(this));
    process.on('SIGINT', this.cleanExit.bind(this));
    process.on('SIGTERM', this.cleanExit.bind(this));

    if (flags.watch || this.environment === 'development') {
      debug('starting watcher');
      this.project.watch({
        outputDir: flags.output,
        onBuild: () => {
          if (this.server) {
            debug('killing existing server');
            this.server.removeAllListeners('exit');
            this.server.kill();
          }
          this.startServer(flags.output);
        }
      });
    } else {
      debug('building project');
      this.project.build(flags.output)
      .then(() => {
        this.startServer(flags.output);
      });
    }
  }

  cleanExit() {
    if (this.server) {
      this.server.kill();
    }
  }

  startServer(dir) {
    let args = [ 'app/index.js' ];
    let defaultEnvs = {
      PORT: this.port,
      DENALI_ENV: this.environment,
      NODE_ENV: this.environment
    };
    if (this.debug) {
      args.unshift('--inspect', '--debug-brk');
    }
    if (!fs.existsSync(path.join(dir, 'app', 'index.js'))) {
      ui.error('Unable to start your application: missing app/index.js file');
      return;
    }
    debug(`starting server process: ${ process.execPath } ${ args.join(' ') }`);
    this.server = spawn(process.execPath, args, {
      cwd: dir,
      stdio: [ 'pipe', process.stdout, process.stderr ],
      env: assign({}, defaultEnvs, process.env)
    });
    this.server.on('error', (error) => {
      ui.error('Unable to start your application:');
      ui.error(error.stack);
    });
    if (this.watch) {
      this.server.on('exit', (code) => {
        let result = code === 0 ? 'exited' : 'crashed';
        ui.error(`Server ${ result }. waiting for changes to restart ...`);
      });
    }
  }

}
