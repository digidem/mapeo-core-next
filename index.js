import { KeyManager, invites } from '@mapeo/crypto'

import { Project } from './lib/project';

export default class MapeoCore {

	/**
	 * @param {object} options
	 * @param {Buffer} options.rootKey
	 */
	constructor ({ rootKey }) {
		this.keyManager = new KeyManager(rootKey)
		this.projects = new Map()
	}

	createRootKey () {
		return KeyManager.generateRootKey()
	}

	project (name, namespace) {
		let project = this.projects.get()
		return new Project(options)
	}

	sendJoinRequest () {

	}

	checkJoinRequest () {

	}

	sendInvite () {

	}

	acceptInvite () {

	}

	getBackupCode () {

	}

	decodeBackupCode () {

	}
}
