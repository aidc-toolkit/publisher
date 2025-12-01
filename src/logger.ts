import { Logger } from "tslog";

/**
 * Log levels.
 */
export const LogLevels = {
    Silly: 0,
    Trace: 1,
    Debug: 2,
    Info: 3,
    Warn: 4,
    Error: 5,
    Fatal: 6
} as const;

/**
 * Log level.
 */
export type LogLevel = typeof LogLevels[keyof typeof LogLevels];

/**
 * Logger with a default minimum level of Info.
 */
export const logger = new Logger({
    minLevel: LogLevels.Info
});

/**
 * Set the log level.
 *
 * @param logLevel
 * Log level as enumeration value or string.
 */
export function setLogLevel(logLevel: string | number): void {
    if (typeof logLevel === "string") {
        if (logLevel in LogLevels) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- String exists as a key.
            logger.settings.minLevel = LogLevels[logLevel as keyof typeof LogLevels];
        } else {
            logger.error(`Unknown log level ${logLevel}`);
        }
    } else {
        logger.settings.minLevel = logLevel;
    }
}
