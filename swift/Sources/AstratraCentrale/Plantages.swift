import Foundation

#if canImport(MetricKit)
import MetricKit
#endif

/// Les plantages que les exceptions Objective-C ne montrent pas, signalés au lancement suivant :
/// - un signal fatal (erreur Swift « fatalError », valeur optionnelle vide forcée, accès mémoire, abandon) : noté sur le
///   disque au moment même, avec des appels permis dans un gestionnaire de signal seulement ;
/// - une fermeture inattendue pendant que l'app était au premier plan, sans plantage noté (mémoire, chien de garde du
///   système, arrêt forcé) : une session ouverte au premier plan qui ne s'est jamais fermée ;
/// - les rapports de plantage d'Apple (MetricKit), avec la pile, livrés par le système au lancement suivant ;
/// - les autres rapports d'Apple : blocages, excès de processeur ou d'écriture disque, lancements lents (avec la pile),
///   et chaque jour les fermetures comptées par raison (mémoire, chien de garde, accès mémoire…).
/// Une app tuée en arrière-plan par le système (normal sur iPhone) n'est jamais signalée.
enum Plantages {
    /// Les signaux fatals suivis.
    static let signaux: [Int32] = [SIGABRT, SIGSEGV, SIGBUS, SIGTRAP, SIGILL, SIGFPE]

    /// Le chemin du fichier où le gestionnaire écrit le numéro du signal (une chaîne C prête d'avance).
    nonisolated(unsafe) static var cheminSignal: UnsafeMutablePointer<CChar>?

    static func fichierSignal(_ dossier: URL) -> URL { dossier.appendingPathComponent("signal.txt") }
    static func fichierPremierPlan(_ dossier: URL) -> URL { dossier.appendingPathComponent("premier-plan") }

    /// Pose les gestionnaires de signal (une fois). Le précédent comportement du système reprend ensuite : l'app
    /// s'arrête comme avant, et le rapport d'Apple est fait comme avant.
    static func capterSignaux(dossier: URL) {
        guard cheminSignal == nil else { return }
        try? FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
        cheminSignal = strdup(fichierSignal(dossier).path)
        for s in signaux {
            signal(s) { numero in
                if let chemin = Plantages.cheminSignal {
                    let fd = open(chemin, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
                    if fd >= 0 {
                        // Le numéro en chiffres, sans allocation (seuls des appels sûrs dans un gestionnaire).
                        var tampon: (UInt8, UInt8, UInt8) = (0, 0, 0)
                        let n = UInt8(clamping: numero)
                        tampon.0 = 48 + n / 10
                        tampon.1 = 48 + n % 10
                        tampon.2 = 10
                        withUnsafeBytes(of: &tampon) { _ = write(fd, $0.baseAddress, 3) }
                        close(fd)
                    }
                }
                signal(numero, SIG_DFL)
                raise(numero)
            }
        }
    }

    /// Le nom lisible d'un signal fatal.
    static func nom(_ numero: Int32) -> String {
        switch numero {
        case SIGABRT: "SIGABRT (abandon)"
        case SIGSEGV: "SIGSEGV (accès mémoire invalide)"
        case SIGBUS: "SIGBUS (accès mémoire invalide)"
        case SIGTRAP: "SIGTRAP (erreur fatale Swift)"
        case SIGILL: "SIGILL (instruction invalide)"
        case SIGFPE: "SIGFPE (erreur de calcul)"
        default: "signal \(numero)"
        }
    }

    /// Le signal noté au lancement précédent (et le fichier effacé), ou nil.
    static func lireSignal(dossier: URL) -> Int32? {
        let fichier = fichierSignal(dossier)
        defer { try? FileManager.default.removeItem(at: fichier) }
        guard let texte = try? String(contentsOf: fichier, encoding: .utf8),
            let n = Int32(texte.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return nil }
        return n
    }

    /// L'app était-elle au premier plan quand elle s'est arrêtée la dernière fois ? (le repère est effacé)
    static func etaitAuPremierPlan(dossier: URL) -> Bool {
        let fichier = fichierPremierPlan(dossier)
        let present = FileManager.default.fileExists(atPath: fichier.path)
        try? FileManager.default.removeItem(at: fichier)
        return present
    }

    static func noterPremierPlan(_ actif: Bool, dossier: URL?) {
        guard let dossier else { return }
        let fichier = fichierPremierPlan(dossier)
        if actif {
            try? FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: fichier.path, contents: Data())
        } else {
            try? FileManager.default.removeItem(at: fichier)
        }
    }
}

#if canImport(MetricKit) && !os(watchOS) && !os(tvOS)
/// Les rapports de plantage d'Apple (MetricKit), livrés par le système, souvent au lancement suivant.
final class AbonneMetricKit: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let partage = AbonneMetricKit()
    private var abonne = false

    func abonner() {
        guard !abonne else { return }
        abonne = true
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        guard let centrale = Centrale.partagee else { return }
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                centrale.signalerPlantageApple(crash)
            }
            for blocage in payload.hangDiagnostics ?? [] {
                let duree = blocage.hangDuration.converted(to: .seconds).value
                centrale.signalerRapportApple(
                    type: "BlocageApple", message: "Interface bloquée \(Self.secondes(duree)) s (rapport d'Apple).",
                    niveau: duree >= 5 ? .erreur : .avertissement, pile: blocage.callStackTree.jsonRepresentation(),
                    etiquettes: ["duree_s": Self.secondes(duree)])
            }
            for cpu in payload.cpuExceptionDiagnostics ?? [] {
                let temps = cpu.totalCPUTime.converted(to: .seconds).value
                centrale.signalerRapportApple(
                    type: "ExcesProcesseur", message: "Trop de calcul : \(Self.secondes(temps)) s de processeur (rapport d'Apple).",
                    niveau: .avertissement, pile: cpu.callStackTree.jsonRepresentation(), etiquettes: ["processeur_s": Self.secondes(temps)])
            }
            for disque in payload.diskWriteExceptionDiagnostics ?? [] {
                let mo = Int(disque.totalWritesCaused.converted(to: .megabytes).value)
                centrale.signalerRapportApple(
                    type: "ExcesEcritureDisque", message: "Trop d'écritures sur le disque : \(mo) Mo (rapport d'Apple).",
                    niveau: .avertissement, pile: disque.callStackTree.jsonRepresentation(), etiquettes: ["ecritures_mo": String(mo)])
            }
            #if os(iOS)
            for lancement in payload.appLaunchDiagnostics ?? [] {
                let duree = lancement.launchDuration.converted(to: .seconds).value
                centrale.signalerRapportApple(
                    type: "LancementLent", message: "Lancement lent : \(Self.secondes(duree)) s (rapport d'Apple).",
                    niveau: .avertissement, pile: lancement.callStackTree.jsonRepresentation(), etiquettes: ["duree_s": Self.secondes(duree)])
            }
            #endif
        }
    }

    /// Le rapport quotidien d'Apple : les fermetures de l'app comptées par raison, et sa mémoire la plus haute.
    func didReceive(_ payloads: [MXMetricPayload]) {
        guard let centrale = Centrale.partagee else { return }
        for payload in payloads {
            var proprietes: [String: ValeurSimple] = [:]
            if let memoire = payload.memoryMetrics?.peakMemoryUsage.converted(to: .megabytes).value {
                proprietes["memoire_max_mo"] = .nombre(memoire.rounded())
            }
            guard let sorties = payload.applicationExitMetrics else {
                if !proprietes.isEmpty { centrale.usage("rapport_apple", proprietes: proprietes) }
                continue
            }
            let premier = Sorties.premierPlan(sorties.foregroundExitData)
            let arriere = Sorties.arrierePlan(sorties.backgroundExitData)
            for (nom, n) in premier where n > 0 { proprietes["premier_plan_" + nom] = .nombre(Double(n)) }
            for (nom, n) in arriere where n > 0 { proprietes["arriere_plan_" + nom] = .nombre(Double(n)) }
            centrale.usage("rapport_apple", proprietes: proprietes.isEmpty ? nil : proprietes)
            let anormales = Sorties.anormales(premierPlan: premier, arrierePlan: arriere)
            if !anormales.isEmpty {
                centrale.signaler(
                    type: "FermeturesSysteme",
                    message: "Apple a compté des fermetures forcées : " + anormales.map { "\($0.nom) × \($0.nombre)" }.joined(separator: ", ") + ".",
                    niveau: .erreur, etiquettes: Dictionary(uniqueKeysWithValues: anormales.map { ($0.nom, String($0.nombre)) }))
            }
        }
    }

    static func secondes(_ valeur: Double) -> String {
        String((valeur * 10).rounded() / 10)
    }
}

/// Les fermetures comptées par Apple, par raison (noms stables pour la Centrale).
enum Sorties {
    static func premierPlan(_ d: MXForegroundExitData) -> [(String, Int)] {
        [("normales", d.cumulativeNormalAppExitCount), ("memoire", d.cumulativeMemoryResourceLimitExitCount),
         ("chien_de_garde", d.cumulativeAppWatchdogExitCount), ("acces_memoire", d.cumulativeBadAccessExitCount),
         ("instruction_invalide", d.cumulativeIllegalInstructionExitCount), ("anormales", d.cumulativeAbnormalExitCount)]
    }

    static func arrierePlan(_ d: MXBackgroundExitData) -> [(String, Int)] {
        [("normales", d.cumulativeNormalAppExitCount), ("memoire", d.cumulativeMemoryResourceLimitExitCount),
         ("pression_memoire", d.cumulativeMemoryPressureExitCount), ("chien_de_garde", d.cumulativeAppWatchdogExitCount),
         ("acces_memoire", d.cumulativeBadAccessExitCount), ("instruction_invalide", d.cumulativeIllegalInstructionExitCount),
         ("anormales", d.cumulativeAbnormalExitCount), ("processeur", d.cumulativeCPUResourceLimitExitCount),
         ("fichier_verrouille", d.cumulativeSuspendedWithLockedFileExitCount),
         ("tache_trop_longue", d.cumulativeBackgroundTaskAssertionTimeoutExitCount)]
    }

    /// Les fermetures qui ne sont pas un choix de la personne : au premier plan, toutes sauf les normales ;
    /// en arrière-plan, seulement celles dues à l'app (la pression mémoire du système y est normale).
    static func anormales(premierPlan: [(String, Int)], arrierePlan: [(String, Int)]) -> [(nom: String, nombre: Int)] {
        let premier = premierPlan.filter { $0.0 != "normales" && $0.1 > 0 }.map { (nom: "premier_plan_" + $0.0, nombre: $0.1) }
        let arriere = arrierePlan
            .filter { ["memoire", "chien_de_garde", "acces_memoire", "instruction_invalide", "anormales", "processeur", "fichier_verrouille", "tache_trop_longue"].contains($0.0) && $0.1 > 0 }
            .map { (nom: "arriere_plan_" + $0.0, nombre: $0.1) }
        return premier + arriere
    }
}

extension Centrale {
    /// Un plantage rapporté par Apple : son type, son signal, la raison de l'arrêt et la pile du fil fautif.
    func signalerPlantageApple(_ crash: MXCrashDiagnostic) {
        var morceaux: [String] = []
        if let t = crash.exceptionType { morceaux.append("exception \(t)") }
        if let c = crash.exceptionCode { morceaux.append("code \(c)") }
        if let s = crash.signal { morceaux.append(Plantages.nom(s.int32Value)) }
        if let r = crash.terminationReason { morceaux.append(r) }
        let pile = Self.pileMetricKit(crash.callStackTree.jsonRepresentation())
        garderEtEnvoyerFatale(type: "Plantage", message: morceaux.joined(separator: " · "), pile: pile)
    }

    /// Un autre rapport d'Apple (blocage, processeur, disque, lancement), avec la pile du fil en cause.
    func signalerRapportApple(type: String, message: String, niveau: Niveau, pile json: Data, etiquettes: [String: String]) {
        garderEtEnvoyer(type: type, message: message, niveau: niveau, pile: Self.pileMetricKit(json), etiquettes: etiquettes)
    }

    /// Les cadres du fil fautif (« threadAttributed ») : bibliothèque et décalage, du cadre fautif vers ses appelants (comme `callStackSymbols`).
    static func pileMetricKit(_ json: Data) -> [Cadre] {
        guard let racine = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
            let piles = racine["callStacks"] as? [[String: Any]]
        else { return [] }
        let fautive = piles.first { ($0["threadAttributed"] as? Bool) == true } ?? piles.first
        var cadres: [Cadre] = []
        var niveau = fautive?["callStackRootFrames"] as? [[String: Any]] ?? []
        let app = Bundle.main.executableURL?.lastPathComponent
        while let cadre = niveau.first, cadres.count < 60 {
            let binaire = cadre["binaryName"] as? String ?? "?"
            let decalage = cadre["offsetIntoBinaryTextSegment"] as? Int
            cadres.append(Cadre(fichier: binaire, fonction: decalage.map { "+\($0)" }, app: binaire == app))
            niveau = cadre["subFrames"] as? [[String: Any]] ?? []
        }
        return cadres
    }
}
#endif
