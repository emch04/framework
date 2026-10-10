import Foundation
import Testing
@testable import AstratraCentrale

/// Un faux transport : garde les corps envoyés et rend les statuts demandés (jamais de réseau).
final class FauxTransport: @unchecked Sendable {
    private let verrou = NSLock()
    private var statuts: [Int]
    private(set) var envois: [[String: Any]] = []
    private(set) var entetes: [[String: String]] = []

    init(statuts: [Int] = []) {
        self.statuts = statuts
    }

    var transport: Transport {
        { requete in
            // Pour vérifier le format contre le serveur : CENTRALE_ECHANTILLON=/chemin écrit chaque corps envoyé.
            if let chemin = ProcessInfo.processInfo.environment["CENTRALE_ECHANTILLON"] {
                try? requete.corps.write(to: URL(fileURLWithPath: chemin + "-\(UUID().uuidString).json"))
            }
            let statut = self.verrou.withLock { () -> Int in
                self.envois.append((try? JSONSerialization.jsonObject(with: requete.corps)) as? [String: Any] ?? [:])
                self.entetes.append(requete.entetes)
                return self.statuts.isEmpty ? 202 : self.statuts.removeFirst()
            }
            return ReponseTransport(statut: statut)
        }
    }

    var evenements: [[String: Any]] {
        verrou.withLock { envois.flatMap { ($0["evenements"] as? [[String: Any]]) ?? [] } }
    }
}

func config(_ cle: String = "clj_pub_essai", dossier: URL? = nil) -> ConfigCentrale {
    ConfigCentrale(cle: cle, adresse: "https://centrale.exemple.test/", plateforme: .ios, version: "1.0.0", appareil: "iPhone17,1", dossier: dossier)
}

@Test func sansCleRienNePart() async {
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(config(""), transport: faux.transport, minuterie: false)
    #expect(centrale.actif == false)
    centrale.message("rien")
    centrale.ia(fournisseur: "gemini", modele: "m", dureeMs: 1, resultat: .ok)
    await centrale.vider()
    #expect(faux.envois.isEmpty)
}

@Test func unLotPartAvecLaCleEtLeContexteSansAppareilEnModeStrict() async {
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(config(), transport: faux.transport, minuterie: false)
    centrale.vue("/titre/3f2a9c1e-0000-4000-8000-000000000001")
    centrale.ia(fournisseur: "gemini", modele: "gemini-3.8-flash", dureeMs: 812, jetonsEntree: 120, jetonsSortie: 45, resultat: .ok)
    await centrale.vider()
    #expect(faux.envois.count == 1)
    #expect(faux.entetes.first?["X-Centrale-Cle"] == "clj_pub_essai")
    let envoi = faux.envois[0]
    #expect(envoi["version"] as? Int == 1)
    let contexte = envoi["contexte"] as? [String: Any]
    #expect(contexte?["plateforme"] as? String == "ios")
    #expect(contexte?["appareil"] == nil, "mode strict : pas d'appareil")
    let evenements = faux.evenements
    #expect(evenements[0]["type"] as? String == "vue")
    #expect(evenements[0]["nom"] as? String == "/titre/:id")
    #expect(evenements[1]["type"] as? String == "ia")
    #expect(evenements[1]["jetonsSortie"] as? Int == 45)
    #expect(Set(evenements[1].keys) == ["type", "horodatage", "fournisseur", "modele", "dureeMs", "jetonsEntree", "jetonsSortie", "resultat"])
}

struct PanneEssai: LocalizedError {
    var errorDescription: String? { "échec pour marie@exemple.fr avec la clé AIzaSyA1234567890abcdefgh" }
}

@Test func uneErreurEstMasqueeAvantEnvoi() async {
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(config(), transport: faux.transport, minuterie: false)
    centrale.miette(.navigation, "ouverture de /compte?token=abcdefghijkl")
    let id = centrale.erreur(PanneEssai())
    await centrale.vider()
    let erreur = faux.evenements.first { $0["type"] as? String == "erreur" }
    #expect(erreur?["id"] as? String == id)
    let texte = String(data: try! JSONSerialization.data(withJSONObject: erreur ?? [:]), encoding: .utf8)!
    #expect(!texte.contains("marie@exemple.fr"))
    #expect(!texte.contains("AIzaSy"))
    #expect(!texte.contains("abcdefghijkl"))
    #expect(texte.contains("[email]"))
    let exception = erreur?["exception"] as? [String: Any]
    #expect(exception?["type"] as? String == "PanneEssai")
    #expect(((exception?["pile"] as? [Any]) ?? []).isEmpty == false)
}

@Test func unRefusDefinitifAbandonneLeLotEtUnePanneLeGarde() async {
    let refus = FauxTransport(statuts: [401])
    let a = Centrale.demarrer(config(), transport: refus.transport, minuterie: false)
    a.message("un")
    await a.vider()
    #expect(a.enAttente == 0, "401 : réessayer ne changerait rien")

    let panne = FauxTransport(statuts: [503])
    let b = Centrale.demarrer(config(), transport: panne.transport, minuterie: false)
    b.message("deux")
    await b.vider()
    #expect(b.enAttente == 1, "503 : le lot est gardé pour plus tard")
}

@Test func laFileBorneeJetteLesUsagesAvantLesErreurs() async {
    var reglages = config()
    reglages.fileMax = 3
    reglages.seuilLot = 1000
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(reglages, transport: faux.transport, minuterie: false)
    centrale.message("erreur gardée")
    for i in 0..<5 { centrale.usage("u\(i)") }
    #expect(centrale.enAttente == 3)
    await centrale.vider()
    #expect(faux.evenements.contains { $0["type"] as? String == "erreur" })
}

@Test func uneSessionTermineeApresUneErreurCompteCommeErreur() async {
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(config(), transport: faux.transport, minuterie: false)
    centrale.session(.debut)
    centrale.message("panne", niveau: .erreur)
    centrale.session(.ok)
    await centrale.vider()
    let sessions = faux.evenements.filter { $0["type"] as? String == "session" }
    #expect(sessions.map { $0["etat"] as? String } == ["debut", "erreur"])
    #expect(sessions[0]["id"] as? String == sessions[1]["id"] as? String)
}

@Test func uneFataleGardeePartAuLancementSuivantAvecUnePlantage() async throws {
    let dossier = FileManager.default.temporaryDirectory.appendingPathComponent("centrale-essai-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dossier) }
    let premier = Centrale.demarrer(config(dossier: dossier), transport: FauxTransport().transport, minuterie: false)
    premier.session(.debut)
    premier.garderFatale(type: "NSRangeException", message: "index 3 hors limites", symboles: Thread.callStackSymbols)

    let faux = FauxTransport()
    let second = Centrale.demarrer(config(dossier: dossier), transport: faux.transport, minuterie: false)
    await second.vider()
    let types = faux.evenements.map { "\($0["type"] ?? "")/\($0["niveau"] ?? $0["etat"] ?? "")" }
    #expect(types == ["erreur/fatal", "session/plantage"])
}

@Test func lesGabaritsEtLeMasquageSuiventLePaquetJavaScript() {
    #expect(Masquage.gabarit("/eleve/123?token=x#a") == "/eleve/:id")
    #expect(Masquage.gabarit("/titre/65f1c2a9b8e4d3f2a1b0c9d8/paroles") == "/titre/:id/paroles")
    #expect(Masquage.texte("Bearer abcdefghijklmnop") == "Bearer [jeton]")
    #expect(Masquage.texte("carte 4111 1111 1111 1111") == "carte [carte]")
    #expect(Masquage.texte("appeler le +33 6 12 34 56 78") == "appeler le [telephone]")
    #expect(Masquage.texte("le 2026-10-10 à 04:12") == "le 2026-10-10 à 04:12")
    #expect(Masquage.texte("password=hunter2") == "password=[masque]")
    #expect(Masquage.texte("Bonjour Léa", noms: ["Léa"]) == "Bonjour [nom]")
}

@Test func unSignalFatalNoteDevientUnPlantageAuLancementSuivant() async throws {
    let dossier = FileManager.default.temporaryDirectory.appendingPathComponent("centrale-essai-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dossier) }
    let premier = Centrale.demarrer(config(dossier: dossier), transport: FauxTransport().transport, minuterie: false)
    premier.session(.debut)
    // Ce que le gestionnaire de signal écrit au moment du plantage (erreur fatale Swift : SIGTRAP).
    try "\(SIGTRAP)\n".write(to: Plantages.fichierSignal(dossier), atomically: true, encoding: .utf8)

    let faux = FauxTransport()
    let second = Centrale.demarrer(config(dossier: dossier), transport: faux.transport, minuterie: false)
    await second.vider()
    let types = faux.evenements.map { "\($0["type"] ?? "")/\($0["niveau"] ?? $0["etat"] ?? "")" }
    #expect(types == ["erreur/fatal", "session/plantage"])
    let exception = String(describing: faux.evenements.first?["exception"] ?? "")
    #expect(exception.contains("SIGTRAP"))
}

@Test func uneFermetureAuPremierPlanSansPlantageEstSignaleeMaisPasEnArrierePlan() async throws {
    let dossier = FileManager.default.temporaryDirectory.appendingPathComponent("centrale-essai-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dossier) }
    // Au premier plan, la session ouverte ne s'est jamais fermée : une fermeture inattendue.
    let premier = Centrale.demarrer(config(dossier: dossier), transport: FauxTransport().transport, minuterie: false)
    premier.session(.debut)
    Plantages.noterPremierPlan(true, dossier: dossier)
    let faux = FauxTransport()
    let second = Centrale.demarrer(config(dossier: dossier), transport: faux.transport, minuterie: false)
    await second.vider()
    #expect(faux.evenements.map { "\($0["type"] ?? "")/\($0["niveau"] ?? $0["etat"] ?? "")" } == ["session/anormal", "erreur/fatal"])

    // En arrière-plan (le système peut tuer l'app sans raison de s'alarmer) : la session seulement, aucune erreur.
    second.session(.debut)
    Plantages.noterPremierPlan(false, dossier: dossier)
    let faux3 = FauxTransport()
    let troisieme = Centrale.demarrer(config(dossier: dossier), transport: faux3.transport, minuterie: false)
    await troisieme.vider()
    #expect(faux3.evenements.map { "\($0["type"] ?? "")/\($0["niveau"] ?? $0["etat"] ?? "")" } == ["session/anormal"])
}
