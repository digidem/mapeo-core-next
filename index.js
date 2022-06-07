import { Project } from './lib/project';

export default class MapeoCore {
	constructor (options = {}) {

	}

	project (options = {}) {
		return new Project(options)
	}
}
