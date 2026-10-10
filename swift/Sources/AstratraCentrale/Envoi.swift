import Foundation

/// Le format d'envoi, identique à celui de `@astratra/centrale` (version 1).
///
/// Requête : `POST {adresse}/v1/envoi`, en-tête `X-Centrale-Cle: clj_pub_…`, corps JSON.
/// Réponses : 202 reçu, 400 format invalide, 401 clé inconnue ou révoquée, 413 trop gros,
/// 429 trop d'envois (`Retry-After`).
public enum Envoi {
    public static let version = 1
    public static let tailleMax = 1024 * 1024
    public static let evenementsMax = 100
    public static let miettesMax = 50
    public static let cadresMax = 100
}

public enum Niveau: String, Codable, Sendable {
    case fatal, erreur, avertissement
}

public enum Plateforme: String, Codable, Sendable {
    case serveur, web, ios, android, bureau
}

public enum Environnement: String, Codable, Sendable {
    case production, preproduction, developpement
}

/// Une ligne de pile d'appels. `app` : vrai si elle appartient à l'application (pas au système).
public struct Cadre: Codable, Sendable, Equatable {
    public var fichier: String
    public var fonction: String?
    public var ligne: Int?
    public var colonne: Int?
    public var app: Bool

    public init(fichier: String, fonction: String? = nil, ligne: Int? = nil, colonne: Int? = nil, app: Bool) {
        self.fichier = fichier
        self.fonction = fonction
        self.ligne = ligne
        self.colonne = colonne
        self.app = app
    }
}

/// Une action récente avant une erreur (fil d'Ariane), déjà masquée.
public struct Miette: Codable, Sendable, Equatable {
    public enum Categorie: String, Codable, Sendable {
        case navigation, requete, clic, console, autre
    }
    public var horodatage: String
    public var categorie: Categorie
    public var message: String
}

public struct Exception: Codable, Sendable, Equatable {
    public var type: String
    public var message: String
    public var pile: [Cadre]
}

/// Résultat d'un appel d'IA.
public enum ResultatIA: String, Codable, Sendable {
    case ok, erreur, quota, repli
}

/// État d'une session, pour le taux de sessions sans plantage.
public enum EtatSession: String, Codable, Sendable {
    case debut, ok, erreur, plantage, anormal
}

/// Un événement du format d'envoi. Encodé avec son champ `type`, comme en JavaScript.
public enum Evenement: Sendable, Equatable {
    case erreur(id: String, horodatage: String, niveau: Niveau, exception: Exception, filAriane: [Miette]?, etiquettes: [String: String]?)
    case session(id: String, horodatage: String, etat: EtatSession, dureeMs: Int?)
    case vue(horodatage: String, nom: String, dureeChargementMs: Int?)
    case usage(horodatage: String, nom: String, proprietes: [String: ValeurSimple]?)
    case ia(horodatage: String, fournisseur: String, modele: String, dureeMs: Int, jetonsEntree: Int?, jetonsSortie: Int?, resultat: ResultatIA, outil: String?)

    /// Plus la valeur est basse, plus l'événement est jeté tôt quand la file déborde.
    var priorite: Int {
        switch self {
        case .erreur: 2
        case .session: 1
        default: 0
        }
    }
}

/// Une propriété simple d'usage : chaîne courte, nombre ou booléen (jamais de texte libre long).
public enum ValeurSimple: Codable, Sendable, Equatable {
    case texte(String)
    case nombre(Double)
    case booleen(Bool)

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .texte(let v): try c.encode(v)
        case .nombre(let v): try c.encode(v)
        case .booleen(let v): try c.encode(v)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .booleen(v) }
        else if let v = try? c.decode(Double.self) { self = .nombre(v) }
        else { self = .texte(try c.decode(String.self)) }
    }
}

extension Evenement: Encodable {
    private enum Cles: String, CodingKey {
        case type, id, horodatage, niveau, exception, filAriane, etiquettes, etat, dureeMs, nom, dureeChargementMs,
             proprietes, fournisseur, modele, jetonsEntree, jetonsSortie, resultat, outil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Cles.self)
        switch self {
        case let .erreur(id, horodatage, niveau, exception, filAriane, etiquettes):
            try c.encode("erreur", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(horodatage, forKey: .horodatage)
            try c.encode(niveau, forKey: .niveau)
            try c.encode(exception, forKey: .exception)
            try c.encodeIfPresent(filAriane, forKey: .filAriane)
            try c.encodeIfPresent(etiquettes, forKey: .etiquettes)
        case let .session(id, horodatage, etat, dureeMs):
            try c.encode("session", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(horodatage, forKey: .horodatage)
            try c.encode(etat, forKey: .etat)
            try c.encodeIfPresent(dureeMs, forKey: .dureeMs)
        case let .vue(horodatage, nom, dureeChargementMs):
            try c.encode("vue", forKey: .type)
            try c.encode(horodatage, forKey: .horodatage)
            try c.encode(nom, forKey: .nom)
            try c.encodeIfPresent(dureeChargementMs, forKey: .dureeChargementMs)
        case let .usage(horodatage, nom, proprietes):
            try c.encode("usage", forKey: .type)
            try c.encode(horodatage, forKey: .horodatage)
            try c.encode(nom, forKey: .nom)
            try c.encodeIfPresent(proprietes, forKey: .proprietes)
        case let .ia(horodatage, fournisseur, modele, dureeMs, jetonsEntree, jetonsSortie, resultat, outil):
            try c.encode("ia", forKey: .type)
            try c.encode(horodatage, forKey: .horodatage)
            try c.encode(fournisseur, forKey: .fournisseur)
            try c.encode(modele, forKey: .modele)
            try c.encode(dureeMs, forKey: .dureeMs)
            try c.encodeIfPresent(jetonsEntree, forKey: .jetonsEntree)
            try c.encodeIfPresent(jetonsSortie, forKey: .jetonsSortie)
            try c.encode(resultat, forKey: .resultat)
            try c.encodeIfPresent(outil, forKey: .outil)
        }
    }
}

/// Le contexte d'un lot : commun à tous ses événements.
public struct Contexte: Codable, Sendable, Equatable {
    public var environnement: Environnement
    public var version: String?
    public var build: String?
    public var plateforme: Plateforme
    public var os: String?
    public var appareil: String?
    public var langue: String?
    public var sessionId: String?
}

struct Enveloppe: Encodable {
    struct SDK: Encodable {
        let nom: String
        let version: String
    }
    let version = Envoi.version
    let sdk: SDK
    let contexte: Contexte
    let evenements: [Evenement]
}
