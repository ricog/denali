import Promise from 'bluebird';
import { exec } from 'child_process';
import startCase from 'lodash/startCase';
import commandExistsCallback from 'command-exists';
import ui from '../../lib/cli/ui';
import Blueprint from '../../lib/cli/blueprint';
import spinner from '../../lib/utils/spinner';
import pkg from '../../package.json';

const run = Promise.promisify(exec);
const commandExists = Promise.promisify(commandExistsCallback);
const maxBuffer = 400 * 1024;

export default class AppBlueprint extends Blueprint {

  static blueprintName = 'app';
  static description = 'Creates a new app, initializes git and installs dependencies';

  params = [ 'name' ];

  flags = {
    'skip-deps': {
      description: 'Do not install dependencies on new app',
      defaultValue: false,
      type: Boolean
    },
    'use-npm': {
      description: 'Use npm to install dependencies, even if yarn is available',
      defaultValue: false,
      type: Boolean
    }
  }

  locals({ name }) {
    return {
      name,
      className: startCase(name).replace(/\s/g, ''),
      humanizedName: startCase(name),
      denaliVersion: pkg.version
    };
  }

  postInstall({ name }, flags) {
    spinner.start('Installing dependencies');
    return Promise.resolve().then(() => {
      if (!flags['skip-deps']) {
        return commandExists('yarn').then((yarnExists) => {
          if (yarnExists && !flags['use-npm']) {
            return run('yarn install --mutex network', { cwd: name });
          }
          return run('npm install --loglevel=error', { cwd: name });
        }).then(() => {
          spinner.succeed();
        }).catch((error) => {
          ui.error('Denali encountered a problem while trying to install the dependencies for your new app:');
          ui.error(error.stack || error.message || error);
        });
      }
    }).then(() => {
      spinner.start('Setting up git repo');
      return run('git init', { cwd: name, maxBuffer });
    }).then(() => {
      return run('git add .', { cwd: name, maxBuffer });
    }).then(() => {
      return run('git commit -am "Initial denali project scaffold"', { cwd: name, maxBuffer });
    }).then(() => {
      spinner.succeed();
      ui.success(`✨  ${ name } created`);
      ui.info('');
      ui.info('To launch your application, just run:');
      ui.info('');
      ui.info(`  $ cd ${ name } && denali server`);
      ui.info('');
    });
  }

}
