import * as fs from 'fs'
import * as path from 'path'

import mri from 'mri'
import dedent from 'dedent'

import MapeoCore from './index.js'

const flags = mri(process.argv.slice(2), {
  alias: {
    help: 'h'
  },
  default: {

  }
})

const args = flags._
const cmd = args.shift()

if (!cmd || cmd === 'help' || flags.help) {
  const message = dedent`
  `

  console.log(message)
}

if (cmd === 'example') {
  const subcmd = args.shift()

  if (subcmd === 'test') {
    console.log('test')
  } else {
    console.log('ok')
  }
} else {
  console.log('cmd:', cmd)
}
