/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as core from '../../core';

import { PEPverToSemver, download, extractTarGz, getCacheDir } from '../helpers';
import { getPythonExecutable, runCommand } from '../../misc';

import BaseStage from './base';
import fs from 'fs-plus';
import path from 'path';
import semver from 'semver';
import tmp from 'tmp';


export default class PlatformIOCoreStage extends BaseStage {

  static UPGRADE_PIOCORE_TIMEOUT = 86400 * 3 * 1000; // 3 days

  static pythonVersion = '2.7.13';
  static vitrualenvUrl = 'https://pypi.python.org/packages/source/v/virtualenv/virtualenv-14.0.6.tar.gz';

  constructor() {
    super(...arguments);
    tmp.setGracefulCleanup();
  }

  get name() {
    return 'PlatformIO Core';
  }

  async whereIsPython() {
    let status = this.params.pythonPrompt.STATUS_TRY_AGAIN;
    do {
      const pythonExecutable = await getPythonExecutable(this.params.useBuiltinPIOCore);
      if (pythonExecutable) {
        return pythonExecutable;
      }

      if (process.platform.startsWith('win')) {
        try {
          return await this.installPythonForWindows();
        } catch (err) {
          console.error(err);
        }
      }

      const result = await this.params.pythonPrompt.prompt();
      status = result.status;
      if (status === this.params.pythonPrompt.STATUS_CUSTOMEXE) {
        return result.pythonExecutable;
      }
    } while (status !== this.params.pythonPrompt.STATUS_ABORT);
    return null;
  }

  async installPythonForWindows() {
    // https://www.python.org/ftp/python/2.7.13/python-2.7.13.msi
    // https://www.python.org/ftp/python/2.7.13/python-2.7.13.amd64.msi
    const pythonArch = process.arch === 'x64' ? '.amd64' : '';
    const msiUrl = `https://www.python.org/ftp/python/${PlatformIOCoreStage.pythonVersion}/python-${PlatformIOCoreStage.pythonVersion}${pythonArch}.msi`;
    const msiInstaller = await download(
      msiUrl,
      path.join(getCacheDir(), path.basename(msiUrl))
    );
    const targetDir = path.join(core.getHomeDir(), 'python27');
    const pythonPath = path.join(targetDir, 'python.exe');

    if (!fs.isFileSync(pythonPath)) {
      try {
        await this.installPythonFromWindowsMSI(msiInstaller, targetDir);
      } catch (err) {
        console.error(err);
        await this.installPythonFromWindowsMSI(msiInstaller, targetDir, true);
      }
    }

    // append temporary to system environment
    process.env.PATH = [targetDir, path.join(targetDir, 'Scripts'), process.env.PATH].join(path.delimiter);
    process.env.Path = process.env.PATH;

    // install virtualenv
    return new Promise(resolve => {
      runCommand(
        'pip',
        ['install', 'virtualenv'],
        () => resolve(pythonPath)
      );
    });
  }

  async installPythonFromWindowsMSI(msiInstaller, targetDir, administrative = false) {
    const logFile = path.join(getCacheDir(), 'python27msi.log');
    await new Promise((resolve, reject) => {
      runCommand(
        'msiexec.exe',
        [administrative ? '/a' : '/i', msiInstaller, '/qn', '/li', logFile, `TARGETDIR=${targetDir}`],
        (code, stdout, stderr) => {
          if (code === 0) {
            return resolve(stdout);
          } else {
            if (fs.isFileSync(logFile)) {
              stderr = fs.readFileSync(logFile).toString();
            }
            return reject(`MSI Python2.7: ${stderr}`);
          }
        },
        {
          spawnOptions: {
            shell: true
          }
        }
      );
    });
    if (!fs.isFileSync(path.join(targetDir, 'python.exe'))) {
      throw new Error('Could not install Python 2.7 using MSI');
    }
  }

  cleanVirtualEnvDir() {
    const envDir = core.getEnvDir();
    if (!fs.isDirectorySync(envDir)) {
      return true;
    }
    try {
      fs.removeSync(envDir);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  isCondaInstalled() {
    return new Promise(resolve => {
      runCommand('conda', ['--version'], code => resolve(code === 0));
    });
  }

  createVirtualenvWithConda() {
    return new Promise((resolve, reject) => {
      runCommand(
        'conda',
        ['create', '--yes', '--quiet', 'python=2', '--prefix', core.getEnvDir()],
        (code, stdout, stderr) => {
          if (code === 0) {
            return resolve(stdout);
          } else {
            return reject(`Conda Virtualenv: ${stderr}`);
          }
        }
      );
    });
  }

  createVirtualenvWithUser(pythonExecutable) {
    return new Promise((resolve, reject) => {
      runCommand(
        'virtualenv',
        ['-p', pythonExecutable, core.getEnvDir()],
        (code, stdout, stderr) => {
          if (code === 0) {
            return resolve(stdout);
          } else {
            return reject(`User's Virtualenv: ${stderr}`);
          }
        }
      );
    });
  }

  async createVirtualenvWithDownload(pythonExecutable) {
    const archivePath = await download(
      PlatformIOCoreStage.vitrualenvUrl,
      path.join(getCacheDir(), 'virtualenv.tar.gz')
    );
    const tmpItem = tmp.dirSync({
      dir: getCacheDir(),
      unsafeCleanup: true
    });
    const dstDir = await extractTarGz(archivePath, tmpItem.name);
    const virtualenvScript = fs.listTreeSync(dstDir).find(
      item => path.basename(item) === 'virtualenv.py');
    if (!virtualenvScript) {
      throw new Error('Can not find virtualenv.py script');
    }
    return new Promise((resolve, reject) => {
      runCommand(
        pythonExecutable,
        [virtualenvScript, core.getEnvDir()],
        (code, stdout, stderr) => {
          try {
            fs.removeSync(dstDir);
          } catch (err) {
            console.error(err);
          }
          if (code === 0) {
            return resolve(stdout);
          } else {
            return reject(`Virtualenv Create: ${stderr}`);
          }
        }
      );
    });
  }

  async installPIOCore() {
    let cmd = 'pip';
    const args = ['install', '--no-cache-dir', '-U'];
    if (this.params.useDevelopmentPIOCore) {
      cmd = path.join(core.getEnvBinDir(), 'pip');
      args.push('https://github.com/platformio/platformio/archive/develop.zip');
    } else {
      args.push('platformio');
    }
    try {
      await new Promise((resolve, reject) => {
        runCommand(cmd, args, (code, stdout, stderr) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(`PIP: ${stderr}`);
          }
        });
      });
    } catch (err) {
      console.error(err);
      // Old versions of PIP don't support `--no-cache-dir` option
      return new Promise((resolve, reject) => {
        runCommand(
          cmd,
          args.filter(arg => arg !== '--no-cache-dir'),
          (code, stdout, stderr) => {
            if (code === 0) {
              resolve(stdout);
            } else {
              reject(`PIP: ${stderr}`);
            }
          }
        );
      });
    }
  }

  initState() {
    let state = this.state;
    if (!state || !state.hasOwnProperty('pioCoreChecked') || !state.hasOwnProperty('lastIDEVersion')) {
      state = {
        pioCoreChecked: 0,
        lastIDEVersion: null
      };
    }
    return state;
  }

  async autoUpgradePIOCore() {
    const newState = this.initState();
    const now = new Date().getTime();
    if (
      (process.env.PLATFORMIO_IDE && newState.lastIDEVersion && newState.lastIDEVersion !== process.env.PLATFORMIO_IDE)
      || ((now - PlatformIOCoreStage.UPGRADE_PIOCORE_TIMEOUT) > parseInt(newState.pioCoreChecked))
    ) {
      newState.pioCoreChecked = now;
      // PIO Core
      await new Promise(resolve => {
        core.runPIOCommand(
          ['upgrade'],
          (code, stdout, stderr) => {
            if (code !== 0) {
              console.error(stdout, stderr);
            }
            resolve(true);
          }
        );
      });
      // PIO Core Packages
      await new Promise(resolve => {
        core.runPIOCommand(
          ['update', '--core-packages'],
          (code, stdout, stderr) => {
            if (code !== 0) {
              console.error(stdout, stderr);
            }
            resolve(true);
          }
        );
      });
    }
    newState.lastIDEVersion = process.env.PLATFORMIO_IDE;
    this.state = newState;
  }

  async check() {
    if (this.params.useBuiltinPIOCore) {
      if (!fs.isDirectorySync(core.getEnvBinDir())) {
        throw new Error('Virtual environment is not created');
      }
      try {
        await this.autoUpgradePIOCore();
      } catch (err) {
        console.error(err);
      }
    }

    const coreVersion = await core.getVersion();
    if (semver.lt(PEPverToSemver(coreVersion), this.params.pioCoreMinVersion)) {
      this.params.setUseBuiltinPIOCore(true);
      throw new Error(`Incompatible PIO Core ${coreVersion}`);
    }

    this.status = BaseStage.STATUS_SUCCESSED;
    console.error(`Found PIO Core ${coreVersion}`);
    return true;
  }

  async install() {
    if (this.status === BaseStage.STATUS_SUCCESSED) {
      return true;
    }
    if (!this.params.useBuiltinPIOCore) {
      this.status = BaseStage.STATUS_SUCCESSED;
      return true;
    }
    this.status = BaseStage.STATUS_INSTALLING;

    this.cleanVirtualEnvDir();

    if (await this.isCondaInstalled()) {
      await this.createVirtualenvWithConda();
    } else {
      const pythonExecutable = await this.whereIsPython();
      if (!pythonExecutable) {
        this.status = BaseStage.STATUS_FAILED;
        throw new Error('Can not find Python Interpreter');
      }
      try {
        await this.createVirtualenvWithUser(pythonExecutable);
      } catch (err) {
        console.error(err);
        await this.createVirtualenvWithDownload(pythonExecutable);
      }
    }

    await this.installPIOCore();

    this.status = BaseStage.STATUS_SUCCESSED;
    return true;
  }

}
