import fs from 'fs-extra';
import path from 'path';
import execa from 'execa';
import { EventEmitter } from 'events';
import got from 'got';
import debugLib from 'debug';
import rimraf from 'rimraf';

const debug = debugLib('skeleton-app');

const getEmberPort = (() => {
  let lastPort = 4210;
  return () => lastPort++;
})();

interface EmberCliOptions {
  args?: string[];
  env?: any;
}

export default class SkeletonApp {
  port = getEmberPort();
  watched: WatchedEmberProcess | null = null;
  watchedTest: WatchedEmberProcess | null = null;
  cleanupTempDir = () => rimraf(this.root, (error) => console.error(error));
  root = path.join(process.cwd(), `test-skeleton-app-${Math.random().toString(36).slice(2)}`);

  constructor() {
    fs.mkdirpSync(this.root);
    fs.copySync(`${__dirname}/../../../test-fixtures/skeleton-app`, this.root);
    process.on('beforeExit', this.cleanupTempDir);
  }

  build() {
    return this._ember({ args: ['build'] });
  }

  serve(options: EmberCliOptions = { args: [], env: {} }) {
    if (this.watched) {
      throw new Error('Already serving');
    }
    options.args = options.args || [];
    options.args = ['serve', '--port', `${this.port}`, ...options.args];
    return (this.watched = new WatchedEmberProcess(this._ember(options), this.port));
  }

  test(options: EmberCliOptions = { args: [], env: {} }) {
    if (this.watchedTest) {
      throw new Error('Already testing');
    }
    options.args = options.args || [];
    options.args = ['test', ...options.args];
    return (this.watchedTest = new WatchedEmberProcess(this._ember(options)));
  }

  updatePackageJSON(callback: (arg: any) => any) {
    let pkgPath = `${this.root}/package.json`;
    let pkg = fs.readJSONSync(pkgPath);
    fs.writeJSONSync(pkgPath, callback(pkg) || pkg, { spaces: 2 });
  }

  writeFile(filePath: string, contents: string) {
    let fullPath = `${this.root}/${filePath}`;
    fs.ensureDirSync(path.dirname(fullPath));
    fs.writeFileSync(fullPath, contents, 'utf-8');
  }

  readFile(path: string) {
    return fs.readFileSync(`${this.root}/${path}`, 'utf-8');
  }

  removeFile(path: string) {
    return fs.unlinkSync(`${this.root}/${path}`);
  }

  teardown() {
    if (this.watched) {
      this.watched.kill();
    }
    if (this.watchedTest) {
      this.watchedTest.kill();
    }
    this.cleanupTempDir();
    process.off('beforeExit', this.cleanupTempDir);
  }

  _ember(options: EmberCliOptions) {
    let ember = require.resolve('ember-cli/bin/ember');
    return execa.node(ember, options.args, { cwd: this.root, all: true, env: options.env });
  }
}

class WatchedEmberProcess extends EventEmitter {
  constructor(protected ember: execa.ExecaChildProcess, protected port?: number) {
    super();
    this.ember.stdout?.on('data', (data) => {
      let output = data.toString();
      if (output.includes('Build successful')) {
        this.emit('did-rebuild');
      }

      debug(output);
    });

    this.ember.stderr?.on('data', (data) => {
      debug(data.toString());
    });

    this.ember.catch((error) => {
      this.emit('did-error', error);
    });
  }

  request(path: string) {
    return got(`http://localhost:${this.port}${path}`);
  }

  raceForOutputs(targets: string[]) {
    return Promise.race(targets.map(target => this.waitForOutput(target)));
  }

  waitForOutput(target: string) {
    return new Promise((resolve) => {
      let output = '';
      let listener = (data: string | Buffer) => {
        output += data.toString();
        if (output.includes(target)) {
          this.ember.stdout?.removeListener('data', listener);
          this.ember.stderr?.removeListener('data', listener);
          resolve(output);
        }
      };

      this.ember.stdout?.on('data', listener);
      this.ember.stderr?.on('data', listener);
    });
  }

  waitForBuild() {
    return new Promise((resolve, reject) => {
      this.once('did-rebuild', resolve);
      this.once('did-error', reject);
    });
  }

  kill() {
    this.ember.kill();
  }
}
