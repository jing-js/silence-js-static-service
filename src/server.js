const crypto = require('crypto');
const fs = require('fs');
const CWD = process.cwd();
const path = require('path');
const zlib = require('zlib');
const cluster = require('cluster');
const util = require('silence-js-util');
const EXT_TYPES = (function() {
  let db = require('mime-db');
  let types = new Map();
  for(let tp in db) {
    let exts = db[tp].extensions;
    if (db[tp].charset) {
      tp = tp + '; charset=' + db[tp].charset;
    }
    exts && exts.forEach(ext => {
      types.set('.' + ext, tp);
    });
  }
  return types;
})();

class File {
  constructor(filename, stat, buffer) {
    this.filename = filename;
    this.buffer = buffer;
    this.mtime = stat.mtime.toUTCString();
    this.gzipBuffer = null;
    this.maxAge = 0;
    this.type = null;
    this.size = 0;
  }
}

class Route {
  constructor(regExp, map, file) {
    this.regExp = regExp;
    this.map = map;
    this.file = file;
  }
}

function gzipFile(f) {
  return new Promise((resolve, reject) => {
    zlib.gzip(f.buffer, (err, result) => {
      if (err) {
        reject(err);
      } else {
        if (f.buffer.length > result.length) {
          f.gzipBuffer = result;
          f.buffer = null;
          f.size = result.length;
        }
        resolve(f);
      }
    });
  });
}

function readdir(dir) {
  return new Promise((resolve, reject) => {
    fs.readdir(dir, (err, files) => {
      if (err) {
        return reject(err);
      } else {
        return resolve(files.map(f => path.join(dir, f)));
      }
    });
  });
}

function stat(file) {
  return new Promise((resolve, reject) => {
    fs.stat(file, (err, result) => {
      if (err) {
        return reject(err);
      } else {
        return resolve(result);
      }
    });
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, result) => {
      if (err) {
        return reject(err);
      } else {
        return resolve(result);
      }
    });
  });
}

function scan(serveDir) {
  return readdir(serveDir).then(files => {
    return Promise.all(
      files.map(file => {
        return stat(file).then(stat => {
          if (stat.isDirectory()) {
            return scan(file);
          } else {
            return readFile(file).then(buffer => {
              return new File(file, stat, buffer);
            });
          }
        })
      })
    ).then(arr => {
      let fileArray = [];
      for(let i = 0; i < arr.length; i++) {
        if (Array.isArray(arr[i])) {
          fileArray = fileArray.concat(arr[i]);
        } else {
          fileArray.push(arr[i]);
        }
      }
      return fileArray;
    })
  });
}

function _s(s) {
  return !s ? '/' : (s[0] === '/' ? s : '/' + s);
}

class Server {
  constructor(config) {
    this.logger = console;
    this.path = path.resolve(CWD, config.path || '');
    this.gzip = config.gzip;
    this.maxAge = config.maxAge;
    this.log404 = config.log404;
    this.log304 = config.log304;
    this.logAccess = config.logAccess;
    this.indexRexExp = new RegExp(`\\/${config.index.replace(/\./g, '\\.')}$`);
    this.files = new Map();
    this.watch = config.watch;
    this.route = Array.isArray(config.route) ? config.route : (config.route ? [config.route] : null);

    if (this.route) {
      for(let i = 0; i < this.route.length; i++) {
        let r = this.route[i];
        if (!config.route || typeof config.route !== 'object' || !r.map || !r.regExp) {
          throw new Error('Invalidate route.');
        }
        this.route[i] = new Route(r.regExp, r.map);
      }
    }

    this._initialized = false;

  }
  init(logger) {
    this.logger = logger;
    return scan(this.path).then(fileArray => {
      return Promise.all(
        fileArray.map(f => {
          f.filename = _s(path.relative(this.path, f.filename));
          f.maxAge = typeof this.maxAge === 'function' ? this.maxAge(f.filename) : this.maxAge;
          f.size = f.buffer.length;
          let ext = path.extname(f.filename);
          if (EXT_TYPES.has(ext)) {
            f.type = EXT_TYPES.get(ext);
          }
          let needGzip = typeof this.gzip === 'function' ? this.gzip(f.filename) : !!this.gzip;
          return needGzip ? gzipFile(f) : Promise.resolve(f);
        })
      ).then(files => {
        files.forEach(f => {
          if (this.files.has(f.filename)) {
            throw new Error('Strange Error', f.filename, 'exists');
          }
          this.files.set(f.filename, f);
          if (this.indexRexExp.test(f.filename)) {
            this.files.set(_s(path.dirname(f.filename)), f);
          }
        });
        if (this.route) {
          for(let i = 0; i < this.route.length; i++) {
            let r = this.route[i];
            if (!this.files.has(r.map)) {
              throw new Error(r.map + 'not found, please check route');
            }
            r.file = this.files.get(r.map);
          }
        }
        if (this.watch) {
          this._watchPath();
        }
        this.logger.debug('Serve path', this.path);
        this._initialized = true;
      });
    });
  }
  _watchPath() {
    this.logger.debug('Watching...');
    fs.watch(this.path, {
      persistent: false,
      recursive: true
    }, (type, file) => {
      setTimeout(() => {
        let filename = path.join(this.path, file);
        return stat(filename).then(st => {
          return readFile(filename).then(buffer => {
            let fn = _s(path.relative(this.path, file));
            let f = this.files.get(fn);
            if (f) {
              f.buffer = buffer;
              f.size = buffer.length;
              f.mtime = st.mtime.toUTCString();
              f.gzipBuffer = null;
              this.logger.debug('Watching...Change', fn);
            } else {
              f = new File(fn, st, buffer);
              f.size = buffer.length;
              let ext = path.extname(f.filename);
              if (EXT_TYPES.has(ext)) {
                f.type = EXT_TYPES.get(ext);
              }
              f.maxAge = typeof this.maxAge === 'function' ? this.maxAge(filename) : this.maxAge;
              this.files.set(fn, f);
              this.logger.debug('Watching...Add', fn);
            }
            let needGzip = typeof this.gzip === 'function' ? this.gzip(f.filename) : !!this.gzip;
            if (needGzip) {
              return gzipFile(f);
            }
          });
        }).catch(err => {
          if (err.message.indexOf('no such file or directory') >= 0) {
            let fn = _s(path.relative(this.path, file));
            this.files.has(fn) && this.files.delete(fn);
            this.logger.debug('Watching...Remove', fn);
          } else {
            this.logger.error(err);            
          }
        });
      }, 500);
    });
  }
  _end(request, response, statusCode) {
    response.writeHead(statusCode);
    response.end();
    // 如果还有更多的数据, 直接 destroy 掉。防止潜在的攻击。
    // 大部份 web 服务器, 当 post 一个 404 的 url 时, 如果跟一个很大的文件, 也会让文件上传
    //  (虽然只是在内存中转瞬即逝, 但总还是浪费了带宽)
    // nginx 服务器对于 404 也不是立刻返回, 也会等待文件上传。 只不过 nginx 有默认的 max_body_size
    // 暂时不清楚是否可以更直观地判断, request 中是否还有待上传的内容。
    request.on('data', destroy);
    request.on('error', exit);
    request.on('close', () => {
      console.log('rrr close')
    });
    request.on('aborted', exit);
    let destroied = false;
    function destroy() {
      if (destroied) {
        return;
      }
      request.destroy();
      exit();
    }
    function exit() {
      if (destroied) {
        return;
      }
      destroied = true;
      request.removeListener('data', destroy);
      request.removeListener('error', exit);
      request.removeListener('close', exit);
      request.removeListener('aborted', exit);
    }
  }

  handle(request, response) {
    
    if (request.method !== 'GET') {
      return this._end(request, response, 405);
    }

    if (!this._initialized) {
      return this._end(request, response, 503);
    }

    let f = this.files.get(request.url);

    if (!f && this.route) {
      for(let i = 0; i < this.route.length; i++) {
        let r = this.route[i];
        if (r.regExp.test(request.url)) {
          f = r.file;
          break;
        }
      }
    }

    if (!f) {
      this._end(request, response, 404);
      this.logAccess && this.log404 && this.logger.access(request.method, 404, 1, request.headers['content-length'] || 0, 0, null, util.getClientIp(request), util.getRemoteIp(request), request.headers['user-agent'], request.url);
      return;
    }

    let mt = request.headers['if-modified-since'];
    if (mt && mt === f.mtime) {
      this._end(request, response, 304);
      this.logAccess && this.log304 && this.logger.access(request.method, 304, 1, request.headers['content-length'] || 0, 0, null, util.getClientIp(request), util.getRemoteIp(request), request.headers['user-agent'], request.url);
      return;
    }

    let headers = {
      'Last-Modified': f.mtime,
      'Content-Length': f.size,
      'Cache-Control': 'max-age=' + f.maxAge
    };
    if (f.gzipBuffer) {
      headers['Content-Encoding'] = 'gzip';
    }
    if (f.type) {
      headers['Content-Type'] = f.type;
    }
    response.writeHead(200, headers);
    response.end(f.gzipBuffer ? f.gzipBuffer : f.buffer);
    request.on('data', () => {
      request.destroy();
    });
    this.logAccess && this.logger.access(request.method, 200, 1, request.headers['content-length'] || 0, 0, null, util.getClientIp(request), util.getRemoteIp(request), request.headers['user-agent'], request.url);

  }
}

module.exports = Server;
