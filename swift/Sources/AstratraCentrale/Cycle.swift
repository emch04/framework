import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/// Le suivi de la vie de l'app : sessions (début au lancement et au retour après 30 s, fin en arrière-plan
/// prolongé ou à la fermeture), vidage de la file en arrière-plan, et exceptions Objective-C non attrapées
/// (gardées sur le disque, envoyées au lancement suivant).
extension Centrale {
    /// Temps passé en arrière-plan après lequel la session est terminée.
    public static let finSessionApres: TimeInterval = 30

    /// À appeler une fois, juste après `demarrer`, depuis le fil principal.
    @MainActor
    public func suivreApplication() {
        guard actif else { return }
        session(.debut)
        Self.capterExceptions()
        if let dossier = config.dossier {
            Plantages.capterSignaux(dossier: dossier)
            Plantages.noterPremierPlan(true, dossier: dossier)
        }
        #if canImport(MetricKit) && !os(watchOS) && !os(tvOS)
        AbonneMetricKit.partage.abonner()
        #endif
        let centre = NotificationCenter.default
        let suivi = SuiviApplication(centrale: self)
        #if canImport(UIKit) && !os(watchOS)
        centre.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.arrierePlan() }
        }
        centre.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.premierPlan() }
        }
        centre.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.fermeture() }
        }
        #elseif canImport(AppKit)
        centre.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.arrierePlan() }
        }
        centre.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.premierPlan() }
        }
        centre.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { suivi.fermeture() }
        }
        #endif
        SuiviApplication.courant = suivi
    }

    private static func capterExceptions() {
        let precedent = NSGetUncaughtExceptionHandler()
        GestionnairePrecedent.valeur = precedent
        NSSetUncaughtExceptionHandler { exception in
            Centrale.partagee?.garderFatale(
                type: exception.name.rawValue, message: exception.reason ?? "", symboles: exception.callStackSymbols)
            GestionnairePrecedent.valeur?(exception)
        }
    }
}

/// Le gestionnaire d'exceptions déjà posé par l'app (appelé après le nôtre).
private enum GestionnairePrecedent {
    nonisolated(unsafe) static var valeur: (@convention(c) (NSException) -> Void)?
}

@MainActor
final class SuiviApplication {
    static var courant: SuiviApplication?
    private let centrale: Centrale
    private var depuis: Date?

    init(centrale: Centrale) {
        self.centrale = centrale
    }

    func arrierePlan() {
        depuis = Date()
        Plantages.noterPremierPlan(false, dossier: centrale.config.dossier)
        let centrale = centrale
        Task { await centrale.vider() }
    }

    func premierPlan() {
        Plantages.noterPremierPlan(true, dossier: centrale.config.dossier)
        guard let depuis else { return }
        self.depuis = nil
        if Date().timeIntervalSince(depuis) >= Centrale.finSessionApres {
            centrale.session(.ok)
            centrale.session(.debut)
        }
    }

    func fermeture() {
        Plantages.noterPremierPlan(false, dossier: centrale.config.dossier)
        centrale.session(.ok)
        // Dernière chance d'envoyer : l'app a quelques secondes avant d'être arrêtée.
        let centrale = centrale
        let fini = DispatchSemaphore(value: 0)
        Task.detached { await centrale.vider(); fini.signal() }
        _ = fini.wait(timeout: .now() + 2)
    }
}
