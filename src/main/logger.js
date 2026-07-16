const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// Log directory setup
const LOG_DIR = path.join(os.homedir(), '.korcul-video-editor', 'logs');

if (!fs.existsSync(LOG_DIR)) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (e) {
        console.error('Failed to create log directory:', e);
    }
}

// Create a new log file for each session (or day)
const dateStr = new Date().toISOString().replace(/:/g, '-').split('T')[0];
const LOG_FILE = path.join(LOG_DIR, `app-log-${dateStr}.txt`);
const RECENT_LOG_TAIL_BYTES = 16 * 1024;

function formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    let msg = message;
    if (args.length > 0) {
        msg += ' ' + args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') return JSON.stringify(a);
            return String(a);
        }).join(' ');
    }
    return `[${timestamp}] [${level}] ${msg}\n`;
}

function writeLog(level, message, ...args) {
    const logLine = formatMessage(level, message, ...args);

    // Write to file (append)
    try {
        fs.appendFileSync(LOG_FILE, logLine, 'utf8');
    } catch (e) {
        // Fallback to console if file write fails, but don't loop
        process.stderr.write('Failed to write to log file: ' + e.message + '\n');
    }

    // Also output to original console
    const originalConsole = level === 'ERROR' ? process.stderr : process.stdout;
    originalConsole.write(logLine);
}

// Override console methods
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

console.log = function (message, ...args) {
    writeLog('INFO', message, ...args);
};

console.error = function (message, ...args) {
    writeLog('ERROR', message, ...args);
};

console.warn = function (message, ...args) {
    writeLog('WARN', message, ...args);
};

console.info = function (message, ...args) {
    writeLog('INFO', message, ...args);
};

// Log application info on start
writeLog('SYSTEM', `Application Started. Version: ${app.getVersion()}`);
writeLog('SYSTEM', `Platform: ${os.platform()} ${os.release()} (${os.arch()})`);
writeLog('SYSTEM', `Log File: ${LOG_FILE}`);

// Catch unhandled exceptions
process.on('uncaughtException', (error) => {
    writeLog('FATAL', 'Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    writeLog('FATAL', 'Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = {
    logPath: LOG_FILE,
    getRecentLogExcerpt(maxLength = 3500) {
        try {
            if (!fs.existsSync(LOG_FILE)) {
                return '';
            }

            const stats = fs.statSync(LOG_FILE);
            const start = Math.max(0, stats.size - RECENT_LOG_TAIL_BYTES);
            const buffer = Buffer.alloc(stats.size - start);
            const fd = fs.openSync(LOG_FILE, 'r');
            fs.readSync(fd, buffer, 0, buffer.length, start);
            fs.closeSync(fd);

            const excerpt = buffer
                .toString('utf8')
                .replace(/\0/g, '')
                .trim();

            if (!excerpt) {
                return '';
            }

            return excerpt.length > maxLength
                ? excerpt.slice(excerpt.length - maxLength)
                : excerpt;
        } catch (error) {
            return `Could not read log excerpt: ${error.message}`;
        }
    }
};
