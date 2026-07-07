
const winston = require('winston');
const path = require('path');
const { logsRoot } = require('./paths');

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level.toUpperCase()} ${info.message}`)
);

const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ 
            filename: path.join(logsRoot, 'crawl_disclosures.log'),
            options: { encoding: 'utf-8' }
        })
    ]
});

module.exports = logger;
