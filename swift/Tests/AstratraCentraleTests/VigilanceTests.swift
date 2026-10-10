import Foundation
import Testing
@testable import AstratraCentrale

/// La surveillance renforcée : ce qui explique une fermeture sans plantage (fil d'Ariane, mémoire, blocage gardés
/// sur le disque), le gardien du fil principal, les fermetures comptées par Apple, le contexte de l'appareil.

private func dossierEssai() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("centrale-vigilance-\(UUID().uuidString)")
}

private func resume(_ evenements: [[String: Any]]) -> [String] {
    evenements.map { "\($0["type"] ?? "")/\($0["niveau"] ?? $0["etat"] ?? "")" }
}

@Test func uneFermetureInattenduePartAvecLeFilDArianeLaMemoireEtLEcran() async {
    let dossier = dossierEssai()
    defer { try? FileManager.default.removeItem(at: dossier) }
    let premier = Centrale.demarrer(config(dossier: dossier), transport: FauxTransport().transport, minuterie: false)
    premier.session(.debut)
    premier.vue("/aria/3f2a9c1e-0000-4000-8000-000000000001")
    premier.miette(.clic, "Appel en direct lancé")
    Plantages.noterPremierPlan(true, dossier: dossier)
    Vigilance.file.sync {}
    let faux = FauxTransport()
    let second = Centrale.demarrer(config(dossier: dossier), transport: faux.transport, minuterie: false)
    await second.vider()
    #expect(resume(faux.evenements) == ["session/anormal", "erreur/fatal"])
    let erreur = faux.evenements[1]
    let fil = (erreur["filAriane"] as? [[String: Any]])?.compactMap { $0["message"] as? String } ?? []
    #expect(fil == ["/aria/:id", "Appel en direct lancé"], "l'écran (en gabarit) puis la dernière action")
    let etiquettes = erreur["etiquettes"] as? [String: String] ?? [:]
    #expect(etiquettes["ecran"] == "/aria/:id")
    #expect(Int(etiquettes["memoire_mo"] ?? "") ?? 0 > 0, "la mémoire de l'app juste avant")
    #expect(Int(etiquettes["memoire_max_mo"] ?? "") ?? 0 > 0)
    #expect(!FileManager.default.fileExists(atPath: Vigilance.fichierEtat(dossier).path), "l'état n'est lu qu'une fois")
}

@Test func uneFermeturePendantUnBlocageEstSignaleeMemeEnArrierePlan() async {
    let dossier = dossierEssai()
    defer { try? FileManager.default.removeItem(at: dossier) }
    let premier = Centrale.demarrer(config(dossier: dossier), transport: FauxTransport().transport, minuterie: false)
    premier.session(.debut)
    premier.miette(.autre, "Lecture")
    premier.noterBlocage(Date(timeIntervalSince1970: 1_800_000_000))
    Plantages.noterPremierPlan(false, dossier: dossier)
    Vigilance.file.sync {}
    let faux = FauxTransport()
    let second = Centrale.demarrer(config(dossier: dossier), transport: faux.transport, minuterie: false)
    await second.vider()
    #expect(resume(faux.evenements) == ["session/anormal", "erreur/fatal"])
    let exception = faux.evenements[1]["exception"] as? [String: Any]
    #expect(exception?["type"] as? String == "FermeturePendantBlocage")
    #expect((faux.evenements[1]["etiquettes"] as? [String: String])?["blocage_depuis"] != nil)
}

@Test func unBlocageTermineEstNoteSurLeDisquePuisSignaleAvecSaDuree() {
    final class Releve: @unchecked Sendable {
        let verrou = NSLock()
        var notes: [Date?] = []
        var signales: [TimeInterval] = []
    }
    let releve = Releve()
    let gardien = GardienBlocage(
        seuil: 2,
        signaler: { _, duree in releve.verrou.withLock { releve.signales.append(duree) } },
        noter: { debut in releve.verrou.withLock { releve.notes.append(debut) } })
    let t0 = Date(timeIntervalSince1970: 1_000)
    gardien.signe(t0)
    gardien.verifier(maintenant: t0.addingTimeInterval(1.5))
    #expect(releve.notes.isEmpty, "sous le seuil : rien")
    gardien.verifier(maintenant: t0.addingTimeInterval(2.5))
    gardien.verifier(maintenant: t0.addingTimeInterval(3.5))
    #expect(releve.notes == [t0], "le début du blocage, noté une seule fois")
    gardien.signe(t0.addingTimeInterval(6))
    #expect(releve.notes == [t0, nil], "fin du blocage effacée du disque")
    #expect(releve.signales == [6], "signalé avec sa durée")
    gardien.signe(t0.addingTimeInterval(6.5))
    #expect(releve.signales.count == 1, "une réponse normale ne signale rien")
}

@Test func chaqueErreurPortLaMemoireEtChaqueEcranEntreDansLeFilDAriane() async {
    let faux = FauxTransport()
    let centrale = Centrale.demarrer(config(), transport: faux.transport, aleatoire: { 0.99 }, minuterie: false)
    centrale.vue("/reglages")
    centrale.message("Le direct n'a pas démarré", etiquettes: ["raison": "micro"])
    await centrale.vider()
    let erreur = faux.evenements.first { $0["type"] as? String == "erreur" }
    let etiquettes = erreur?["etiquettes"] as? [String: String] ?? [:]
    #expect(etiquettes["raison"] == "micro")
    #expect(Int(etiquettes["memoire_mo"] ?? "") ?? 0 > 0)
    let fil = (erreur?["filAriane"] as? [[String: Any]])?.compactMap { $0["message"] as? String }
    #expect(fil == ["/reglages"])
}

@Test func lesFermeturesCompteesParAppleSeparentLesForceesDesNormales() {
    let premier = [("normales", 12), ("memoire", 2), ("chien_de_garde", 1), ("acces_memoire", 0)]
    let arriere = [("normales", 3), ("pression_memoire", 5), ("memoire", 1), ("tache_trop_longue", 0)]
    let anormales = Sorties.anormales(premierPlan: premier, arrierePlan: arriere)
    #expect(anormales.map(\.nom) == ["premier_plan_memoire", "premier_plan_chien_de_garde", "arriere_plan_memoire"])
    #expect(anormales.map(\.nombre) == [2, 1, 1])
}

@Test func horsModeStrictLAppareilEstDecritAutomatiquement() async {
    let faux = FauxTransport()
    var reglages = config()
    reglages.strict = false
    reglages.appareil = nil
    let centrale = Centrale.demarrer(reglages, transport: faux.transport, minuterie: false)
    centrale.message("essai")
    await centrale.vider()
    let appareil = (faux.envois.first?["contexte"] as? [String: Any])?["appareil"] as? String ?? ""
    #expect(appareil.contains(" Go"), "modèle et mémoire de l'appareil")
    #expect(appareil == Appareil.decrire())
}
