import type { PluginInput } from "@opencode-ai/plugin";
export type Bridge = {
    onEvent(event: {
        type: string;
        properties: unknown;
    }): Promise<void>;
    dispose(): Promise<void>;
};
export declare function createBridge(input: PluginInput): Promise<Bridge | null>;
