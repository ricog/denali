import fs from 'fs';
import path from 'path';
import dedent from 'dedent-js';
import { padEnd } from 'lodash';
import ui from '../lib/cli/ui';
import Command from '../lib/cli/command';
import Project from '../lib/cli/project';
import Blueprint from '../lib/cli/blueprint';

export default class DestroyCommand extends Command {

  static commandName = 'destroy';
  static description = 'Remove scaffolded code from your app';
  static longDescription = dedent`
    Removes the code generated during a \`denali generate\` command. Errs on the
    side of caution when deleting code - it will only remove files that exactly
    match the generated output. Modified files will be left untouched. `;

  params = [ 'blueprintName', 'otherArgs' ];

  flags = {};

  runsInApp = true;

  allowExtraArgs = true;

  run({ params }, argTokens) {
    if (!params.blueprintName) {
      this.printHelp();
    } else {
      let project = new Project();
      let blueprint = Blueprint.instanceFor(project, params.blueprintName);
      let args = this.parseArgs.call(blueprint, argTokens.slice(1));
      blueprint.destroy(args);
    }
  }

  printHelp() {
    super.printHelp();
    ui.info('Available Blueprints:');
    let blueprints = fs.readdirSync(path.join(__dirname, '..', 'blueprints'));
    let pad = blueprints.reduce((length, name) => Math.max(length, name.length), 0);
    blueprints.forEach((blueprintName) => {
      const BlueprintClass = require(`../blueprints/${ blueprintName }`).default;
      ui.info(`  ${ padEnd(blueprintName, pad) }  ${ BlueprintClass.description }`);
    });
  }

}
