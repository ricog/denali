import Blueprint from '../../lib/cli/blueprint';

export default class ServiceBlueprint extends Blueprint {

  static blueprintName = 'service';
  static description = 'Generates a blank service';

  params = [ 'name' ];

}
