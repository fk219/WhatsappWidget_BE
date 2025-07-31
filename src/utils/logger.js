// Logging utility with color-coded levels and timestamp formatting
const colors = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const getTimestamp = () => new Date().toISOString();

const formatMessage = (message, data = null) => {
  let logMessage = `[${getTimestamp()}] ${message}`;
  if (data) logMessage += typeof data === 'object' ? `\n${JSON.stringify(data, null, 2)}` : ` ${String(data)}`;
  return logMessage;
};

const logger = {
  error: (message, data) => console.error(`${colors.red}${formatMessage(message, data)}${colors.reset}`),
  warn: (message, data) => console.warn(`${colors.yellow}${formatMessage(message, data)}${colors.reset}`),
  info: (message, data) => console.log(`${colors.cyan}${formatMessage(message, data)}${colors.reset}`),
  debug: (message, data) => process.env.NODE_ENV === 'development' && console.debug(`${colors.green}${formatMessage(message, data)}${colors.reset}`)
};

export const logError = logger.error;
export const logWarn = logger.warn; // Changed from logWarning to logWarn for consistency
export const logInfo = logger.info;
export const logDebug = logger.debug;
export default logger;