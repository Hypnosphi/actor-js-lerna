const path = require('path')
const shell = require('shelljs')
const shellEscape = require('shell-escape')
const fs = require('fs')
const detectIndent = require('detect-indent')

const REPO_PATH = '/repo'
const TESTING = (process.env.DEPENDENCIES_ENV || 'production') == 'test'
const ACTOR_ID = process.env.ACTOR_ID
const GIT_SHA = process.env.GIT_SHA
const NPMRC = process.env.SETTING_NPMRC
const BATCH_MODE = JSON.parse(process.env.SETTING_BATCH_MODE || 'false')
const BATCH_BOOTSTRAP = JSON.parse(process.env.SETTING_BATCH_BOOTSTRAP || 'false')
const dependencies = JSON.parse(process.env.DEPENDENCIES)['dependencies']

shell.set('-e')  // any failing shell commands will fail
shell.set('-v')

// first need to install root dependencies so that the repo's version
// of lerna is available
if (process.env.SETTING_ROOT_INSTALL_COMMAND) {
    shell.exec(process.env.SETTING_ROOT_INSTALL_COMMAND)
} else if (fs.existsSync('yarn.lock')) {
    shell.exec('yarn install --ignore-scripts --frozen-lockfile --non-interactive')
} else if (fs.existsSync('package-lock.json')) {
    shell.exec('npm install --ignore-scripts --quiet')
} else if (fs.existsSync('package.json')) {
    shell.exec('npm install --ignore-scripts --quiet --no-package-lock')
}

function bootstrap() {
  if (!BATCH_MODE) {
    try {
        shell.exec('lerna clean --yes')
    } catch (e) {
        console.log('Unable to run `lerna clean`, check output.')
    }
  }
  shell.exec(process.env.SETTING_BOOTSTRAP_COMMAND || 'lerna bootstrap --concurrency 1')
}

if (NPMRC) {
    console.log('.npmrc contents found in settings, writing to /home/app/.npmrc...')
    fs.writeFileSync('/home/app/.npmrc', NPMRC)
    console.log(NPMRC)
}

const batchPrBranchName = `dependencies.io-update-build-${ACTOR_ID}`
if (BATCH_MODE) {
  shell.exec(`git checkout -b ${batchPrBranchName}`)
}

dependencies.forEach(function(dependency) {
  console.log(dependency)

  const name = dependency.name
  const installed = dependency.installed.version
  const version = dependency.available[0].version
  let branchName = `${name}-${version}-${ACTOR_ID}`
  if (dependency.path !== '/') {
      branchName = branchName + '-' + dependency.path.replace('/', '--')
  }
  const msg = `Update ${name} from ${installed} to ${version} in ${dependency.path}`

  if (!BATCH_MODE) {
    // branch off of the original commit that this build is on
    shell.exec(`git checkout ${GIT_SHA}`)
    shell.exec(`git checkout -b ${branchName}`)
  }

  const packageJsonPath = path.join(REPO_PATH, dependency.path, 'package.json')
  const file = fs.readFileSync(packageJsonPath, 'utf8')
  // tries to detect the indentation and falls back to a default if it can't
  const indent = detectIndent(file).indent || '  '
  const packageJson = JSON.parse(file)

  const depTypes = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'bundledDependencies',
  ]

  depTypes.forEach(t => {
    if (packageJson.hasOwnProperty(t) && packageJson[t].hasOwnProperty(name)) {
      const currentRange = packageJson[t][name]
      // get the prefix they were using and keep using it
      let packageJsonVersionRangeSpecifier = ''
      if (currentRange.startsWith('^')) {
        packageJsonVersionRangeSpecifier = '^'
      } else if (currentRange.startsWith('~')) {
        packageJsonVersionRangeSpecifier = '~'
      }
      // update package.json with the new range
      const constraint = packageJsonVersionRangeSpecifier + version
      console.log(`Updating ${name} to ${constraint} in ${t} of ${packageJsonPath}`)
      packageJson[t][name] = constraint
    }
  })

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, indent) + '\n')

  if (!BATCH_BOOTSTRAP) {
    bootstrap()
  }

  console.log('This is the git status after performing the update:')
  shell.exec('git status')

  shell.exec('git add .')
  shell.exec(`git commit -m "${msg}"`)

  if (!BATCH_MODE) {
    if (!TESTING) {
      shell.exec(`git push --set-upstream origin ${branchName}`)
    }
    dependencyJSON = JSON.stringify({'dependencies': [dependency]})
    shell.exec(shellEscape(['pullrequest', '--branch', branchName, '--dependencies-schema', dependencyJSON, '--title-from-schema', '--body-from-schema']))
    console.log(`BEGIN_DEPENDENCIES_SCHEMA_OUTPUT>${dependencyJSON}<END_DEPENDENCIES_SCHEMA_OUTPUT`)
  }
})

if (BATCH_MODE) {
  if (BATCH_BOOTSTRAP) {
    bootstrap()
  }

  const msg = dependencies.length + ' packages updated by dependencies.io'
  dependencyJSON = JSON.stringify({'dependencies': dependencies})

  if (!TESTING) {
    shell.exec(`git push --set-upstream origin ${batchPrBranchName}`)
  }

  shell.exec(shellEscape(['pullrequest', '--branch', batchPrBranchName, '--dependencies-schema', dependencyJSON, '--title-from-schema', '--body-from-schema']))

  // mark them all complete at once
  console.log(`BEGIN_DEPENDENCIES_SCHEMA_OUTPUT>${dependencyJSON}<END_DEPENDENCIES_SCHEMA_OUTPUT`)
}
