import type { Connector, GovernanceStore, ResourceDeclaration } from '../index';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export declare function createPostgresConnector(options: { pool: PoolLike; resources: Record<string, ResourceDeclaration>; isolation?: 'repeatable read' | 'serializable' }): Connector;
export declare function createPostgresGovernanceStore(pool: Queryable, options?: { prefix?: string }): GovernanceStore;
export declare function postgresGovernanceSchema(options?: { prefix?: string }): string;
