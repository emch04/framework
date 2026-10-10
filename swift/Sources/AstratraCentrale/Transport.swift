import Foundation

/// Une requête prête à partir : adresse complète, en-têtes et corps JSON.
public struct RequeteTransport: Sendable {
    public let url: URL
    public let entetes: [String: String]
    public let corps: Data
}

/// Ce que la file a besoin de savoir de la réponse.
public struct ReponseTransport: Sendable {
    public let statut: Int
    /// Valeur brute de l'en-tête `Retry-After`, s'il y en a une.
    public let reessayerApres: String?

    public init(statut: Int, reessayerApres: String? = nil) {
        self.statut = statut
        self.reessayerApres = reessayerApres
    }
}

/// Le transport : injecté pour les tests ; par défaut, `URLSession`. Peut lever (hors ligne) :
/// la file l'attrape et réessaie plus tard.
public typealias Transport = @Sendable (RequeteTransport) async throws -> ReponseTransport

public enum Transports {
    /// Transport par défaut, avec un délai maximal pour ne jamais rester bloqué.
    public static func urlSession(delai: TimeInterval = 10) -> Transport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = delai
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        return { requete in
            var demande = URLRequest(url: requete.url)
            demande.httpMethod = "POST"
            for (nom, valeur) in requete.entetes { demande.setValue(valeur, forHTTPHeaderField: nom) }
            demande.httpBody = requete.corps
            let (_, reponse) = try await session.data(for: demande)
            let http = reponse as? HTTPURLResponse
            return ReponseTransport(statut: http?.statusCode ?? 0, reessayerApres: http?.value(forHTTPHeaderField: "Retry-After"))
        }
    }
}

/// Délai en secondes demandé par `Retry-After` (secondes ou date HTTP), ou nil s'il est illisible.
func lireRetryAfter(_ valeur: String?, maintenant: Date) -> TimeInterval? {
    guard let texte = valeur?.trimmingCharacters(in: .whitespaces), !texte.isEmpty else { return nil }
    if let secondes = Double(texte) { return max(0, secondes) }
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.timeZone = TimeZone(identifier: "GMT")
    format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    guard let date = format.date(from: texte) else { return nil }
    return max(0, date.timeIntervalSince(maintenant))
}
