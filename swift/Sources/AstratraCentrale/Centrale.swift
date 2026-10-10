import Foundation

/// Les réglages de la collecte. Sans clé ni adresse, rien ne se passe (`actif` est faux).
public struct ConfigCentrale: Sendable {
    /// Clé publique du projet (`clj_pub_…`) : elle sert seulement à envoyer.
    public var cle: String
    /// Adresse du serveur, par exemple `https://centrale.exemple.fr`.
    public var adresse: String
    public var environnement: Environnement
    public var plateforme: Plateforme
    public var version: String?
    public var build: String?
    public var os: String?
    /// Ignoré en mode strict.
    public var appareil: String?
    public var langue: String?
    /// Mode strict (par défaut) : ni utilisateur, ni appareil précis.
    public var strict: Bool
    /// Coupe tout (refus de l'utilisateur, tests…).
    public var desactive: Bool
    /// Noms propres à masquer partout.
    public var noms: [String]
    /// Taux entre 0 et 1 pour les vues, usages et appels d'IA. Les erreurs et sessions ne sont jamais échantillonnées.
    public var echantillonnage: (vues: Double, usages: Double, ia: Double)
    /// Réglages de la file (surtout pour les tests).
    public var fileMax = 500
    public var seuilLot = 50
    public var intervalle: TimeInterval = 10
    public var reculBase: TimeInterval = 2
    public var reculMax: TimeInterval = 300
    /// Dossier où garder une erreur fatale et la session en cours entre deux lancements (nil : pas de mémoire).
    public var dossier: URL?

    public init(
        cle: String, adresse: String, environnement: Environnement = .production, plateforme: Plateforme,
        version: String? = nil, build: String? = nil, os: String? = nil, appareil: String? = nil, langue: String? = nil,
        strict: Bool = true, desactive: Bool = false, noms: [String] = [],
        echantillonnage: (vues: Double, usages: Double, ia: Double) = (1, 1, 1), dossier: URL? = nil
    ) {
        self.cle = cle
        self.adresse = adresse
        self.environnement = environnement
        self.plateforme = plateforme
        self.version = version
        self.build = build
        self.os = os
        self.appareil = appareil
        self.langue = langue
        self.strict = strict
        self.desactive = desactive || cle.trimmingCharacters(in: .whitespaces).isEmpty || adresse.trimmingCharacters(in: .whitespaces).isEmpty
        self.noms = noms
        self.echantillonnage = echantillonnage
        self.dossier = dossier
    }
}

/// La collecte vers un serveur Centrale : file bornée, masquage à la source, envoi par lots avec reprises.
///
/// Règle d'or : rien ne lève chez l'appelant et rien ne bloque l'app. Les méthodes publiques sont
/// synchrones et rendent la main tout de suite ; l'envoi se fait en tâche de fond.
public final class Centrale: @unchecked Sendable {
    public static let nomSDK = "astratra-centrale-swift"
    public static let versionSDK = "1.0.0"

    /// L'instance créée par le dernier `demarrer` (utile pour les erreurs captées loin de l'app).
    public static var partagee: Centrale? {
        get { verrouPartage.withLock { _partagee } }
        set { verrouPartage.withLock { _partagee = newValue } }
    }
    nonisolated(unsafe) private static var _partagee: Centrale?
    private static let verrouPartage = NSLock()

    public let config: ConfigCentrale
    public var actif: Bool { !config.desactive }

    private let transport: Transport
    private let maintenant: @Sendable () -> Date
    private let aleatoire: @Sendable () -> Double
    private let minuterie: Bool
    private let verrou = NSLock()
    private var contexte: Contexte
    private var file: [(evenement: Evenement, contexte: Contexte)] = []
    private var miettes: [Miette] = []
    private var debutSession: Date?
    private var erreursSession = 0
    private var echecs = 0
    private var pauseJusqua = Date.distantPast
    private var envoiEnCours: Task<Void, Never>?
    private var boucleMinuterie: Task<Void, Never>?
    private let horloge = ISO8601DateFormatter()

    /// Démarre la collecte et la rend partagée. `transport`, `maintenant`, `aleatoire` et `minuterie` servent aux tests.
    @discardableResult
    public static func demarrer(
        _ config: ConfigCentrale, transport: Transport? = nil, maintenant: @escaping @Sendable () -> Date = { Date() },
        aleatoire: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }, minuterie: Bool = true
    ) -> Centrale {
        let centrale = Centrale(config: config, transport: transport ?? Transports.urlSession(), maintenant: maintenant, aleatoire: aleatoire, minuterie: minuterie)
        partagee = centrale
        centrale.reprendreLancementPrecedent()
        centrale.planifier()
        return centrale
    }

    init(config: ConfigCentrale, transport: @escaping Transport, maintenant: @escaping @Sendable () -> Date, aleatoire: @escaping @Sendable () -> Double, minuterie: Bool) {
        self.config = config
        self.transport = transport
        self.maintenant = maintenant
        self.aleatoire = aleatoire
        self.minuterie = minuterie
        horloge.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let noms = config.noms
        let propre: (String?) -> String? = { $0.flatMap { $0.isEmpty ? nil : Masquage.texte($0, noms: noms) } }
        contexte = Contexte(
            environnement: config.environnement, version: propre(config.version), build: propre(config.build),
            plateforme: config.plateforme, os: propre(config.os), appareil: config.strict ? nil : propre(config.appareil),
            langue: propre(config.langue), sessionId: nil)
    }

    // MARK: - Ce que l'app appelle

    /// Une erreur Swift. Rend l'identifiant de l'événement, ou nil si rien n'est gardé.
    @discardableResult
    public func erreur(_ e: Error, niveau: Niveau = .erreur, etiquettes: [String: String]? = nil) -> String? {
        let type = String(reflecting: Swift.type(of: e)).split(separator: ".").last.map(String.init) ?? "Error"
        let message = (e as? LocalizedError)?.errorDescription ?? String(describing: e)
        return enregistrerErreur(type: type, message: message, pile: Pile.lire(Thread.callStackSymbols), niveau: niveau, etiquettes: etiquettes)
    }

    /// Un message d'erreur sans `Error` (un état impossible, une réponse inattendue…).
    @discardableResult
    public func message(_ texte: String, niveau: Niveau = .avertissement, etiquettes: [String: String]? = nil) -> String? {
        enregistrerErreur(type: "Message", message: texte, pile: Pile.lire(Thread.callStackSymbols), niveau: niveau, etiquettes: etiquettes)
    }

    /// Un écran vu. `nom` est un gabarit (`/titre/:id`), jamais un nom avec un identifiant réel.
    public func vue(_ nom: String, dureeChargementMs: Int? = nil) {
        guard actif, aleatoire() < config.echantillonnage.vues else { return }
        ajouter(.vue(horodatage: horodatage(), nom: Masquage.gabarit(nom), dureeChargementMs: dureeChargementMs.map { max(0, $0) }))
    }

    /// Une fonction utilisée, avec des propriétés simples (jamais de texte libre long).
    public func usage(_ nom: String, proprietes: [String: ValeurSimple]? = nil) {
        guard actif, aleatoire() < config.echantillonnage.usages else { return }
        let props = proprietes?.mapValues { valeur -> ValeurSimple in
            if case .texte(let t) = valeur { return .texte(String(t.prefix(200))) }
            return valeur
        }
        ajouter(.usage(horodatage: horodatage(), nom: String(nom.prefix(200)), proprietes: props?.isEmpty == true ? nil : props))
    }

    /// Un appel à un modèle d'IA. Jamais le contenu des messages : seuls ces champs existent.
    public func ia(fournisseur: String, modele: String, dureeMs: Int, jetonsEntree: Int? = nil, jetonsSortie: Int? = nil, resultat: ResultatIA, outil: String? = nil) {
        guard actif, aleatoire() < config.echantillonnage.ia else { return }
        ajouter(.ia(
            horodatage: horodatage(), fournisseur: String(fournisseur.prefix(100)), modele: String(modele.prefix(100)),
            dureeMs: max(0, dureeMs), jetonsEntree: jetonsEntree.map { max(0, $0) }, jetonsSortie: jetonsSortie.map { max(0, $0) },
            resultat: resultat, outil: outil.map { String($0.prefix(100)) }))
    }

    /// Début ou fin de session, pour le taux de sessions sans plantage.
    public func session(_ etat: EtatSession) {
        guard actif else { return }
        verrou.lock()
        if etat == .debut {
            let id = UUID().uuidString.lowercased()
            contexte.sessionId = id
            debutSession = maintenant()
            erreursSession = 0
            verrou.unlock()
            ajouter(.session(id: id, horodatage: horodatage(), etat: .debut, dureeMs: nil))
            noterSessionEnCours(id: id)
            return
        }
        guard let id = contexte.sessionId else { verrou.unlock(); return }
        let final: EtatSession = etat == .ok && erreursSession > 0 ? .erreur : etat
        let duree = debutSession.map { Int(maintenant().timeIntervalSince($0) * 1000) }
        verrou.unlock()
        ajouter(.session(id: id, horodatage: horodatage(), etat: final, dureeMs: duree.map { max(0, $0) }))
        verrou.withLock { contexte.sessionId = nil }
        effacerSessionEnCours()
    }

    /// Une action récente (fil d'Ariane), jointe à la prochaine erreur. Masquée tout de suite.
    public func miette(_ categorie: Miette.Categorie, _ message: String) {
        guard actif else { return }
        let m = Miette(horodatage: horodatage(), categorie: categorie, message: Masquage.texte(String(message.prefix(500)), noms: config.noms))
        verrou.withLock {
            miettes.append(m)
            if miettes.count > Envoi.miettesMax { miettes.removeFirst(miettes.count - Envoi.miettesMax) }
        }
    }

    /// Envoie tout ce qui peut l'être maintenant. Ne lève jamais.
    public func vider() async {
        guard actif else { return }
        let tache: Task<Void, Never> = verrou.withLock {
            if let enCours = envoiEnCours { return enCours }
            let nouvelle = Task<Void, Never> { [weak self] in await self?.boucle() }
            envoiEnCours = nouvelle
            return nouvelle
        }
        await tache.value
        verrou.withLock { if envoiEnCours == tache { envoiEnCours = nil } }
    }

    /// Arrête la minuterie (les événements restent en file).
    public func arreter() {
        verrou.withLock {
            boucleMinuterie?.cancel()
            boucleMinuterie = nil
        }
    }

    /// Nombre d'événements en attente.
    public var enAttente: Int { verrou.withLock { file.count } }

    // MARK: - Plantages

    /// Garde une erreur fatale sur le disque (appelé juste avant que l'app s'arrête) : elle part au lancement suivant.
    func garderFatale(type: String, message: String, symboles: [String]) {
        guard actif, let dossier = config.dossier else { return }
        let exception = Exception(type: String(type.prefix(200)), message: Masquage.texte(String(message.prefix(4000)), noms: config.noms), pile: Pile.lire(symboles))
        let fatale = Fatale(id: UUID().uuidString.lowercased(), horodatage: horodatage(), exception: exception, sessionId: verrou.withLock { contexte.sessionId })
        if let donnees = try? JSONEncoder().encode(fatale) {
            try? FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
            try? donnees.write(to: dossier.appendingPathComponent("fatale.json"), options: .atomic)
        }
    }

    private struct Fatale: Codable {
        let id: String
        let horodatage: String
        let exception: Exception
        let sessionId: String?
    }

    private struct SessionEnCours: Codable {
        let id: String
        let debut: Date
    }

    private func noterSessionEnCours(id: String) {
        guard let dossier = config.dossier, let debut = verrou.withLock({ debutSession }) else { return }
        try? FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
        if let donnees = try? JSONEncoder().encode(SessionEnCours(id: id, debut: debut)) {
            try? donnees.write(to: dossier.appendingPathComponent("session.json"), options: .atomic)
        }
    }

    private func effacerSessionEnCours() {
        guard let dossier = config.dossier else { return }
        try? FileManager.default.removeItem(at: dossier.appendingPathComponent("session.json"))
    }

    /// Au démarrage : l'erreur fatale du lancement précédent, et sa session restée ouverte (« plantage » ou « anormal »).
    private func reprendreLancementPrecedent() {
        guard actif, let dossier = config.dossier else { return }
        let fichierFatale = dossier.appendingPathComponent("fatale.json")
        let fichierSession = dossier.appendingPathComponent("session.json")
        var fatale: Fatale?
        if let donnees = try? Data(contentsOf: fichierFatale) {
            fatale = try? JSONDecoder().decode(Fatale.self, from: donnees)
            try? FileManager.default.removeItem(at: fichierFatale)
            if let f = fatale {
                ajouter(.erreur(id: f.id, horodatage: f.horodatage, niveau: .fatal, exception: f.exception, filAriane: nil, etiquettes: nil))
            }
        }
        // Un signal fatal (erreur Swift, accès mémoire…) noté au moment même : un plantage, même sans exception.
        if fatale == nil, let numero = Plantages.lireSignal(dossier: dossier) {
            let exception = Exception(type: "Plantage", message: Plantages.nom(numero), pile: [])
            let f = Fatale(id: UUID().uuidString.lowercased(), horodatage: horodatage(), exception: exception, sessionId: nil)
            ajouter(.erreur(id: f.id, horodatage: f.horodatage, niveau: .fatal, exception: f.exception, filAriane: nil, etiquettes: nil))
            fatale = f
        }
        let auPremierPlan = Plantages.etaitAuPremierPlan(dossier: dossier)
        if let donnees = try? Data(contentsOf: fichierSession), let ouverte = try? JSONDecoder().decode(SessionEnCours.self, from: donnees) {
            try? FileManager.default.removeItem(at: fichierSession)
            let plantee = fatale != nil && (fatale?.sessionId == nil || fatale?.sessionId == ouverte.id)
            let etat: EtatSession = plantee ? .plantage : .anormal
            ajouter(.session(id: ouverte.id, horodatage: horodatage(), etat: etat, dureeMs: nil))
            // Fermée pendant l'usage sans plantage noté (mémoire, chien de garde, arrêt forcé) : signalée aussi comme
            // un problème, pas seulement comme une session anormale.
            if !plantee, auPremierPlan {
                let exception = Exception(type: "FermetureInattendue", message: "L'app s'est fermée au premier plan sans se terminer normalement.", pile: [])
                ajouter(.erreur(id: UUID().uuidString.lowercased(), horodatage: horodatage(), niveau: .fatal, exception: exception, filAriane: nil, etiquettes: nil))
            }
        }
    }

    /// Un plantage connu après coup (rapport d'Apple) : envoyé tout de suite comme une erreur fatale.
    func garderEtEnvoyerFatale(type: String, message: String, pile: [Cadre]) {
        guard actif else { return }
        let exception = Exception(type: String(type.prefix(200)), message: Masquage.texte(String(message.prefix(4000)), noms: config.noms), pile: pile)
        ajouter(.erreur(id: UUID().uuidString.lowercased(), horodatage: horodatage(), niveau: .fatal, exception: exception, filAriane: nil, etiquettes: nil))
    }

    // MARK: - File d'attente

    private func horodatage() -> String {
        verrou.withLock { horloge.string(from: maintenant()) }
    }

    private func enregistrerErreur(type: String, message: String, pile: [Cadre], niveau: Niveau, etiquettes: [String: String]?) -> String? {
        guard actif else { return nil }
        let id = UUID().uuidString.lowercased()
        let fil = verrou.withLock { () -> [Miette] in
            if contexte.sessionId != nil { erreursSession += 1 }
            return miettes
        }
        let exception = Exception(type: String(type.prefix(200)), message: String(message.prefix(4000)), pile: pile)
        let etiquettesBornees = etiquettes?.mapValues { String($0.prefix(200)) }
        ajouter(.erreur(id: id, horodatage: horodatage(), niveau: niveau, exception: exception, filAriane: fil.isEmpty ? nil : fil, etiquettes: etiquettesBornees))
        return id
    }

    /// Masque l'événement puis le place en respectant la borne (on jette d'abord les usages, jamais une erreur avant).
    private func ajouter(_ evenement: Evenement) {
        let masque = masquer(evenement)
        let declencher: Bool = verrou.withLock {
            file.append((masque, contexte))
            while file.count > config.fileMax {
                let plusBasse = file.map(\.evenement.priorite).min() ?? 0
                if let index = file.firstIndex(where: { $0.evenement.priorite == plusBasse }) { file.remove(at: index) }
            }
            return file.count >= config.seuilLot
        }
        if declencher { Task { [weak self] in await self?.vider() } }
    }

    private func masquer(_ evenement: Evenement) -> Evenement {
        let noms = config.noms
        let m: (String) -> String = { Masquage.texte($0, noms: noms) }
        switch evenement {
        case let .erreur(id, horodatage, niveau, exception, filAriane, etiquettes):
            let pile = exception.pile.map { c in Cadre(fichier: m(c.fichier), fonction: c.fonction.map(m), ligne: c.ligne, colonne: c.colonne, app: c.app) }
            return .erreur(id: id, horodatage: horodatage, niveau: niveau,
                           exception: Exception(type: m(exception.type), message: m(exception.message), pile: pile),
                           filAriane: filAriane, etiquettes: etiquettes?.mapValues(m))
        case let .vue(horodatage, nom, duree):
            return .vue(horodatage: horodatage, nom: m(nom), dureeChargementMs: duree)
        case let .usage(horodatage, nom, proprietes):
            return .usage(horodatage: horodatage, nom: m(nom), proprietes: proprietes?.mapValues { v in
                if case .texte(let t) = v { return .texte(m(t)) }
                return v
            })
        case .session, .ia:
            return evenement
        }
    }

    private func recul() -> TimeInterval {
        min(config.reculMax, config.reculBase * pow(2, Double(max(0, echecs - 1))))
    }

    /// Retire de la file un lot de même contexte, sous les limites de nombre et de taille.
    private func prendreLot() -> (lot: [(evenement: Evenement, contexte: Contexte)], corps: Data)? {
        verrou.withLock {
            let encodeur = JSONEncoder()
            while let premier = file.first {
                var n = 0
                while n < file.count && n < Envoi.evenementsMax && file[n].contexte == premier.contexte { n += 1 }
                while n >= 1 {
                    let lot = Array(file.prefix(n))
                    let enveloppe = Enveloppe(sdk: .init(nom: Centrale.nomSDK, version: Centrale.versionSDK), contexte: premier.contexte, evenements: lot.map(\.evenement))
                    if let corps = try? encodeur.encode(enveloppe), corps.count <= Envoi.tailleMax {
                        file.removeFirst(n)
                        return (lot, corps)
                    }
                    if n == 1 { break }
                    n = (n + 1) / 2
                }
                // Un seul événement trop gros (ou illisible) : abandonné plutôt que de bloquer la file.
                file.removeFirst()
            }
            return nil
        }
    }

    private func remettre(_ lot: [(evenement: Evenement, contexte: Contexte)]) {
        verrou.withLock { file.insert(contentsOf: lot, at: 0) }
    }

    private func boucle() async {
        guard let url = URL(string: config.adresse.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/envoi") else { return }
        while true {
            if maintenant() < verrou.withLock({ pauseJusqua }) { return }
            guard let pris = prendreLot() else { return }
            var statut = 0
            var reessayerApres: String?
            do {
                let reponse = try await transport(RequeteTransport(url: url, entetes: ["Content-Type": "application/json", "X-Centrale-Cle": config.cle], corps: pris.corps))
                statut = reponse.statut
                reessayerApres = reponse.reessayerApres
            } catch {
                statut = 0
            }
            if (200..<300).contains(statut) {
                verrou.withLock { echecs = 0 }
                continue
            }
            if (400..<500).contains(statut) && statut != 408 && statut != 429 {
                // 400, 401, 413… : réessayer ne changerait rien, le lot est abandonné.
                continue
            }
            // 429, 5xx, 408 ou aucune réponse : on garde le lot et on recule.
            verrou.withLock {
                echecs += 1
                let attente = statut == 429 ? (lireRetryAfter(reessayerApres, maintenant: maintenant()) ?? recul()) : recul()
                pauseJusqua = maintenant().addingTimeInterval(attente)
            }
            remettre(pris.lot)
            return
        }
    }

    private func planifier() {
        guard actif, minuterie else { return }
        let intervalle = config.intervalle
        verrou.withLock {
            boucleMinuterie = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(intervalle))
                    guard let self, !Task.isCancelled else { return }
                    await self.vider()
                }
            }
        }
    }
}
