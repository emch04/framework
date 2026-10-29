import type { Connector, GovernanceStore, ResourceDeclaration } from '../index';

/** Le strict nécessaire du pilote officiel (`Db`, `MongoClient`) : le pack ne l'importe pas. */
export interface MongoDbLike { collection(name: string): any; admin(): { command(command: Record<string, unknown>): Promise<any> } }
export interface MongoClientLike { startSession(): any }

export declare function createMongoConnector(options: {
  db: MongoDbLike;
  client?: MongoClientLike | null;
  resources: Record<string, ResourceDeclaration>;
  /** La classe ObjectId du pilote, pour les colonnes de type objectId. */
  ObjectId?: new (hex: string) => unknown;
  /** false : sans jeu de réplicas, une seule écriture par proposition, revérifiée par toute la ligne lue à l'aperçu. */
  transactions?: boolean;
}): Connector & { check(): Promise<boolean> };
export declare function createMongoGovernanceStore(db: MongoDbLike, options?: { collection?: string }): GovernanceStore;
export declare function mongoGovernanceIndexes(db: MongoDbLike, options?: { collection?: string }): Promise<void>;
