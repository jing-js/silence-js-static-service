#!/usr/bin/env node

const program = require('commander');
const FileLogger = require('silence-js-log-file');
const ConsoleLogger = require('silence-js-log-console');
const numCPUs = require('os').cpus().length;
const path = require('path');
const fs = require('fs');
const cluster = require('cluster');

const SIG_MAP = {
  'reload': 'SIGHUP',
  'stop': 'SIGINT',
  'status': 'SIGINFO'
}

function mergeConfig(target, source) {
  for(let k in target) {
    if (typeof target[k] === 'object' && target[k] !== null && typeof source[k] === 'object' && source[k] !== null) {
      mergeConfig(target[k], source[k]);
    } else if (typeof source[k] !== 'undefined' && source[k] !== null) {
      target[k] = source[k];
    }
  }
}

program
  .version(require('../package.json').version || '1.0.0')
  .option('-p, --port [port]', 'Server listen port, default is 80', parseInt)
  .option('-H, --host [host]', 'Server listen host, default is 0.0.0.0')
  .option('-s, --signal [signal]', 'Send signal to running silence-static-server process')
  .option('--cluster', 'Use cluster, default is true')
  .option('--dev', 'Development mode, alias of `--port=8888 --cluster=false --logger=console --log-level=debug`')
  .option('--pid-path [pidPath]', 'Pid file path')
  .option('--config [configFile]', 'Specify config file')
  .option('--log-level [logLevel]', 'Log level, default is info')
  .option('--logger [logger]', 'File or Console logger, default is file')
  .option('--log-path [logPath]', 'Path for store file logs, default is /var/log/silence-static-server')
  .option('-w, --watch', 'Watch file and reload to memory, default is false')
  .option('--max-age [maxAge]', 'File cache max age in seconds, default is 600. Set to 0 to disable cache.', parseInt)
  .option('--gzip', 'Gzip files, default is true.')
  .option('--user [user]', 'User, ignore to use current user')
  .option('--group [group]', 'Group, ignore to use current group')
  .parse(process.argv);

const config = require('../config');

let customConfig = {};

if (program.configFile) {
  customConfig = require(program.configFile);
  mergeConfig(config, customConfig);
}

if (program.dev) {
  config.port = 8888;
  config.cluster = false;
  config.logger = 'console';
  config.logLevel = 'debug';
  config.user = process.env.SUDO_USER || process.env.USER || '';
  config.group = '';
}

mergeConfig(config, {
  port: program.port,
  host: program.host,
  logger: program.logger,
  logLevel: program.logLevel,
  logPath: program.logPath,
  watch: program.watch,
  gzip: program.gzip,
  maxAge: program.maxAge,
  path: program.args[0],
  pidPath: program.pidPath,
  user: program.user,
  group: program.group,
  cluster: program.cluster
});

if (program.dev && cluster.isMaster) {
  console.log(`Silence-static-server dev mode \n\t--port=${config.port} \n\t--cluster=${config.cluster} \n\t--logger=${config.logger} \n\t--log-level=${config.logLevel} \n\t--user=${config.user}`);
}

const pidFile = path.join(path.resolve(process.cwd(), config.pidPath), `silence-static-server.pid`);

if (cluster.isMaster && program.signal) {
  try {
    fs.accessSync(pidFile)
  } catch(err) {
    console.error('Can\'t find pid file');
    return;
  }
  let sig = SIG_MAP[(program.signal || '').toLowerCase()];
  if (!sig) {
    console.error('Unknown signal', program.signal);
    return;
  }
  let pid = parseInt(fs.readFileSync(pidFile, 'utf-8'));
  console.log(`Send ${sig} to ${pid}`);
  try {
    process.kill(pid, sig);      
  } catch(err) {
    console.error(err.stack || err.message || err.toString());
  }
  return;
}

const LOG_PREFIX = cluster.isMaster ? (config.cluster ? '[MASTER] ' : '') : `[WORK_${cluster.worker.id}] `;
process.title = cluster.isMaster ? (config.cluster ? 'SILENCE_STATIC_SERVER_MASTER' : 'SILENCE_STATIC_SERVER') : `SILENCE_STATIC_SERVER_WORKER_${cluster.worker.id}`;

function runMaster(logger) {

  try {
    fs.writeFileSync(pidFile, process.pid);
  } catch(err) {
    logger.error(err.stack || err.message || err.toString());
    logger.info(process.title, 'Exit due to error.');
    return;
  }

  let __cleanup = false;

  if (config.cluster) {
    cluster.on('exit', (worker, code, signal) => {
      if (__cleanup) {
        return;
      }
      logger.info(`Worker ${worker.id} ${worker.process.pid} died`);
      let newWorker = cluster.fork(); // restart
      logger.info(`Worker ${newWorker.id} ${newWorker.process.pid} created`);
    });
  }

  process.on('exit', () => {
    _exitMaster();
  });

  process.on('SIGTERM', _exitMaster);
  process.on('SIGINT', _exitMaster);
  process.on('SIGHUP', function () {
    if (__cleanup) {
      return;
    }
    logger.info('Got SIGHUP signal, reload.');
    for(let id in cluster.workers) {
      cluster.workers[id].send('RELOAD');
    }
  });

  function _exitMaster() {
    if (__cleanup) {
      return;
    }
    __cleanup = true;
    for(let id in cluster.workers) {
      logger.info(`Sending STOP to worker ${id}`);
      cluster.workers[id].send('STOP');
    }
    try {
      fs.unlinkSync(pidFile);
    } catch(err) {
      logger.error(err.stack || err.message || err.toString());
    }
    logger.info(process.title, 'Exit!');
    logger.close();    
    if (!config.cluster) process.exit(0);
  }

}

function runWorker(logger) {
  
  let __cleanup = false;

  process.on('message', msg => {
    if (__cleanup) {
      return;
    }
    // logger.info('Got message from cluster master', msg);
    if (msg === 'RELOAD' || msg === 'STOP') {
      _exitWorker();
    }
  });  
  process.on('exit', _exitWorker);
  process.on('SIGHUP', _exitWorker);
  process.on('SIGTERM', _exitWorker);
  process.on('SIGINT', _exitWorker);

  function _exitWorker() {
    if (__cleanup) {
      return;
    }
    __cleanup = true;
    logger.info(process.title, 'Exit!');
    logger.close();
    process.exit(0);
  }
}

function changeUser(user, group) {
  if (!process.getuid || !process.setuid || !process.setgid) {
    return;
  }
  if (cluster.isMaster && config.cluster) {
    return;
  }
  if (user) {
    try {
      process.setuid(user);    
    } catch(err) {
      console.error('Set uid to', user, 'failed');
      console.error(err.stack || err.message || err.toString());
    }
  }
  let uid = process.getuid();
  if (uid === 0) {
    console.log(LOG_PREFIX + 'WARNING: You are runing under root user, it\'s dangerous.');
  }
  if (group) {
    try {
      process.setgid(group);      
    } catch(err) {
      console.error(LOG_PREFIX + 'Set gid to', group, 'failed');
      console.error(err.stack || err.message || err.toString());
    }
  }
}

function prepare(app) {

  if (cluster.isMaster && config.cluster) {
    for(let i = 0; i < numCPUs; i++) {
      console.log(LOG_PREFIX + 'Starting worker', i + 1);
      cluster.fork();
    }
  }

  changeUser(config.user, config.group);
  if (config.logger === 'file') {
    try {
      fs.accessSync(path.resolve(process.cwd(), config.logPath), fs.constants.F_OK | fs.constants.W_OK);
    } catch(err) {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        console.error('Log path not exists or current user have no permission to write.');
        console.error(`Plaese make sure "${config.logPath}" exists and ${config.user} have write permission`);
      } else {
        console.error(err.stack || err.message || err.toString());
      }
      console.log(LOG_PREFIX + 'Progress exit due to error.');
      if (!cluster.isMaster || !config.cluster) process.exit(0);
    }
  }

  let logger = config.logger.toLowerCase() !== 'file' ? new ConsoleLogger({
    level: config.logLevel,
    cluster: cluster.isMaster ? (config.cluster ? 'master' : '') : `work_${cluster.worker.id}`
  }) : new FileLogger({
    level: config.logLevel,
    path: config.logPath,
    cluster: cluster.isMaster ? (config.cluster ? 'master' : '') : `work_${cluster.worker.id}`
  });
  logger.init().then(() => {
    process.on('uncaughtException', err => {
      logger.error('UNCAUGHT EXCEPTION');
      logger.error(err.stack || err.message || err.toString());
    });
    if (cluster.isMaster) {
      runMaster(logger);
    } else {
      runWorker(logger);
    }
    return app ? app.init(logger) : null;
  }).catch(err => {
    console.error(err.stack || err.message || err.toString());
    process.exit(0);
  });

}

function run() {

  if (!cluster.isMaster || !config.cluster) {
    const http = require('http');
    const { Server } = require('../index');

    const app = new Server(config);
    const server = http.createServer((request, response) => {
      app.handle(request, response);
    });

    server.listen(config.port, config.host, () => {
      console.log(LOG_PREFIX + `Silence Static Server ${cluster.isMaster ? '' : 'worker'} listen at ${config.host}:${config.port}`);
      prepare(app);
    });
  } else {
    prepare(null);
  }
}

run(); // Run program
