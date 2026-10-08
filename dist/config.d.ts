export type BridgeConfig = {
    botToken: string;
    appToken: string;
    channel: string;
    allowedUsers: string[];
};
export type ConfigResult = {
    ok: true;
    config: BridgeConfig;
} | {
    ok: false;
    reason: string;
};
/**
 * Loads KEY=VALUE pairs from <directory>/.env into process.env.
 * Existing environment variables always win, so exported values are
 * never clobbered by the file.
 */
export declare function loadDotenv(directory: string): void;
export declare function loadConfig(directory: string): ConfigResult;
