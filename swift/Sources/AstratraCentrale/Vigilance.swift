import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/// Ce qui explique une fermeture que rien n'a captée (mémoire saturée, app bloquée tuée par le chien de garde du
/// système, arrêt forcé) : le dernier état de l'app est gardé sur le disque au fil de l'eau, et repart avec le
/// signalement au lancement suivant.
///
/// - le fil d'Ariane (les 50 dernières actions, déjà masquées) ;
/// - la mémoire occupée par l'app, au moment de la dernière action ;
/// - un blocage du fil principal en cours (depuis quand), noté pendant qu'il dure.
struct EtatGarde: Codable, Equatable {
    var miettes: [Miette] = []
    var memoireMo: Int?
    var blocageDepuis: Date?
    /// Plus forte mémoire vue pendant le lancement.
    var memoireMaxMo: Int?
}

enum Vigilance {
    static func fichierEtat(_ dossier: URL) -> URL { dossier.appendingPathComponent("etat.json") }

    /// Les écritures sur le disque passent par une seule file, en arrière-plan : jamais sur le fil de l'appelant.
    static let file = DispatchQueue(label: "astratra.centrale.etat", qos: .utility)

    static func ecrire(_ etat: EtatGarde, dossier: URL) {
        guard let donnees = try? JSONEncoder().encode(etat) else { return }
        try? FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
        try? donnees.write(to: fichierEtat(dossier), options: .atomic)
    }

    /// L'état gardé au lancement précédent (et le fichier effacé), ou nil.
    static func lire(dossier: URL) -> EtatGarde? {
        let fichier = fichierEtat(dossier)
        defer { try? FileManager.default.removeItem(at: fichier) }
        guard let donnees = try? Data(contentsOf: fichier) else { return nil }
        return try? JSONDecoder().decode(EtatGarde.self, from: donnees)
    }

    /// La mémoire physique occupée par l'app (« empreinte », celle que le système compare à sa limite), en Mo.
    static func memoireMo() -> Int? {
        var info = task_vm_info_data_t()
        var nombre = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let resultat = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(nombre)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &nombre)
            }
        }
        guard resultat == KERN_SUCCESS else { return nil }
        return Int(info.phys_footprint / 1_048_576)
    }
}

/// L'appareil, pour le contexte des envois hors mode strict : son modèle (« iPhone17,2 », « Mac15,3 ») et sa mémoire.
public enum Appareil {
    public static func decrire() -> String {
        let memoire = Int((Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824).rounded())
        return "\(modele()) · \(memoire) Go"
    }

    static func modele() -> String {
        #if os(macOS)
        var taille = 0
        sysctlbyname("hw.model", nil, &taille, nil, 0)
        guard taille > 0 else { return "Mac" }
        var octets = [CChar](repeating: 0, count: taille)
        sysctlbyname("hw.model", &octets, &taille, nil, 0)
        return String(decoding: octets.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        #else
        if let simule = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simule + " (simulateur)" }
        var systeme = utsname()
        uname(&systeme)
        return withUnsafeBytes(of: &systeme.machine) { octets in
            String(decoding: octets.prefix { $0 != 0 }, as: UTF8.self)
        }
        #endif
    }
}

/// Le gardien du fil principal : une app dont l'interface ne répond plus (blocage) est signalée, avec sa durée,
/// l'écran et le fil d'Ariane. Pendant le blocage, son début est noté sur le disque : si le système tue l'app
/// (chien de garde), le lancement suivant le dit.
final class GardienBlocage: @unchecked Sendable {
    /// Au-delà, le fil principal est considéré bloqué.
    let seuil: TimeInterval
    private let pas: TimeInterval
    private let verrou = NSLock()
    private var dernierSigne = Date()
    private var bloqueDepuis: Date?
    private var fil: Thread?
    private let signaler: @Sendable (_ debut: Date, _ duree: TimeInterval) -> Void
    private let noter: @Sendable (_ debut: Date?) -> Void

    init(
        seuil: TimeInterval = 2, pas: TimeInterval = 0.5,
        signaler: @escaping @Sendable (Date, TimeInterval) -> Void, noter: @escaping @Sendable (Date?) -> Void
    ) {
        self.seuil = seuil
        self.pas = pas
        self.signaler = signaler
        self.noter = noter
    }

    func demarrer() {
        let fil = Thread { [weak self] in
            while let self, !Thread.current.isCancelled {
                self.verifier(maintenant: Date())
                DispatchQueue.main.async { [weak self] in self?.signe(Date()) }
                Thread.sleep(forTimeInterval: self.pas)
            }
        }
        fil.name = "astratra.centrale.gardien"
        fil.qualityOfService = .utility
        verrou.withLock { self.fil = fil }
        fil.start()
    }

    func arreter() {
        verrou.withLock { fil?.cancel(); fil = nil }
    }

    /// Le fil principal a répondu : un blocage en cours se termine et part.
    func signe(_ instant: Date) {
        let fini: Date? = verrou.withLock {
            dernierSigne = instant
            defer { bloqueDepuis = nil }
            return bloqueDepuis
        }
        if let debut = fini {
            noter(nil)
            signaler(debut, instant.timeIntervalSince(debut))
        }
    }

    /// Sans réponse depuis plus que le seuil : le blocage commence (noté une fois).
    func verifier(maintenant: Date) {
        let debut: Date? = verrou.withLock {
            guard bloqueDepuis == nil, maintenant.timeIntervalSince(dernierSigne) > seuil else { return nil }
            bloqueDepuis = dernierSigne
            return dernierSigne
        }
        if let debut { noter(debut) }
    }
}

/// Les alertes de l'appareil, en fil d'Ariane ou en signalement : mémoire saturée, chaleur, économie d'énergie.
@MainActor
final class SuiviAppareil {
    static var courant: SuiviAppareil?
    private let centrale: Centrale
    private var derniereAlerteMemoire = Date.distantPast
    #if os(macOS)
    private var pression: DispatchSourceMemoryPressure?
    #endif

    init(centrale: Centrale) {
        self.centrale = centrale
    }

    func demarrer() {
        let centre = NotificationCenter.default
        #if canImport(UIKit) && !os(watchOS)
        centre.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { SuiviAppareil.courant?.memoire(critique: false) }
        }
        #endif
        #if os(macOS)
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak source] in
            let critique = source?.data.contains(.critical) ?? false
            MainActor.assumeIsolated { SuiviAppareil.courant?.memoire(critique: critique) }
        }
        source.resume()
        pression = source
        #endif
        centre.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { SuiviAppareil.courant?.chaleur() }
        }
        #if os(iOS)
        centre.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { _ in
            let actif = ProcessInfo.processInfo.isLowPowerModeEnabled
            MainActor.assumeIsolated { SuiviAppareil.courant?.centrale.miette(.autre, "Économie d'énergie \(actif ? "activée" : "désactivée")") }
        }
        #endif
    }

    /// Mémoire saturée : toujours dans le fil d'Ariane ; signalée au plus une fois par minute.
    func memoire(critique: Bool, maintenant: Date = Date()) {
        let mo = Vigilance.memoireMo()
        let texte = "Mémoire \(critique ? "critique" : "saturée")" + (mo.map { " (app : \($0) Mo)" } ?? "")
        centrale.miette(.autre, texte)
        guard maintenant.timeIntervalSince(derniereAlerteMemoire) >= 60 else { return }
        derniereAlerteMemoire = maintenant
        var etiquettes = ["alerte": critique ? "critique" : "avertissement"]
        if let mo { etiquettes["memoire_mo"] = String(mo) }
        centrale.signaler(type: "MemoireSaturee", message: "Le système manque de mémoire : l'app risque d'être fermée.", niveau: .avertissement, etiquettes: etiquettes)
    }

    func chaleur() {
        let etat: String = switch ProcessInfo.processInfo.thermalState {
        case .nominal: "normale"
        case .fair: "tiède"
        case .serious: "chaude"
        case .critical: "critique"
        @unknown default: "inconnue"
        }
        centrale.miette(.autre, "Température de l'appareil : \(etat)")
        if ProcessInfo.processInfo.thermalState == .critical {
            centrale.signaler(type: "Surchauffe", message: "L'appareil est en surchauffe critique : le système ralentit ou ferme les apps.", niveau: .avertissement, etiquettes: nil)
        }
    }
}
