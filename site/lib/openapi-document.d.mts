import type { Document } from 'fumadocs-openapi';

export declare const OPENAPI_FILE: string;
export declare const SCHEMA_ID: string;
export declare function shortPath(path: string): string;
export declare function loadOrkstageDocument(file?: string): Document;
