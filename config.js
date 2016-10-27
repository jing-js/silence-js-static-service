module.exports = {
  port: 80,
  host: '0.0.0.0',
  logger: 'file',
  logLevel: 'info',
  logPath: '/var/log/silence-static-server',
  log404: true,
  logAccess: true,
  log304: true,
  cluster: true,
  user: 'silence',
  group: 'www',
  pidPath: __dirname,
  path: '.',
  gzip: true,
  maxAge: function(file) {
    return /\.min\.(?:css|js)$/.test(file) ? 30 * 24 * 60 * 60 : 10 * 60;
  },
  watch: false,
  index: 'index.html',
  route: [{
    regExp: /^(?:\/test)|(?:\/workspace\/[\w]+)$/,
    map: '/index.html'
  }]
};
