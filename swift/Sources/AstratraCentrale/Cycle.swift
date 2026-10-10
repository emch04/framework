import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

/// Le suivi de la vie de l'app : sessions (début au lancement et au retour après 30 s, fin en arrière-plan
/// prolongé ou à la fermeture), vidage de la file en arrière-plan, exceptions Objective-C non attrapées
/// (gardées sur le disque, envoyées au lancement suivant), blocages du fil principal, alertes de l'appareil
/// (mémoire, chaleur, économie d'énergie) et passages au premier plan ou en arrière-plan dans le fil d'Ariane.
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
        let appareil = SuiviAppareil(centrale: self)
        SuiviAppareil.courant = appareil
        appareil.demarrer()
        suivi.demarrerGardien()
        miette(.autre, "Lancement de l'app")
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
    private var gardien: GardienBlocage?

    init(centrale: Centrale) {
        self.centrale = centrale
    }

    /// Le gardien du fil principal : un blocage de plus de 2 s est signalé (avertissement), et au-delà de 5 s
    /// comme une erreur (le système tue une app bloquée trop longtemps).
    func demarrerGardien() {
        guard gardien == nil else { return }
        let centrale = centrale
        let gardien = GardienBlocage(
            signaler: { debut, duree in
                let secondes = (duree * 10).rounded() / 10
                centrale.miette(.autre, "Interface bloquée \(secondes) s")
                centrale.signaler(
                    type: "AppBloquee", message: "L'interface n'a pas répondu pendant \(secondes) s.",
                    niveau: duree >= 5 ? .erreur : .avertissement,
                    etiquettes: ["duree_s": String(secondes), "debut": ISO8601DateFormatter().string(from: debut)])
            },
            noter: { debut in centrale.noterBlocage(debut) })
        gardien.demarrer()
        self.gardien = gardien
    }

    func arrierePlan() {
        depuis = Date()
        centrale.miette(.autre, "Arrière-plan")
        #if os(iOS)
        // En arrière-plan, iOS suspend l'app : le gardien prendrait la suspension pour un blocage.
        gardien?.arreter()
        gardien = nil
        #endif
        Plantages.noterPremierPlan(false, dossier: centrale.config.dossier)
        let centrale = centrale
        Task { await centrale.vider() }
    }

    func premierPlan() {
        Plantages.noterPremierPlan(true, dossier: centrale.config.dossier)
        centrale.miette(.autre, "Premier plan")
        demarrerGardien()
        guard let depuis else { return }
        self.depuis = nil
        if Date().timeIntervalSince(depuis) >= Centrale.finSessionApres {
            centrale.session(.ok)
            centrale.session(.debut)
        }
    }

    func fermeture() {
        gardien?.arreter()
        Plantages.noterPremierPlan(false, dossier: centrale.config.dossier)
        centrale.session(.ok)
        // Dernière chance d'envoyer : l'app a quelques secondes avant d'être arrêtée.
        let centrale = centrale
        let fini = DispatchSemaphore(value: 0)
        Task.detached { await centrale.vider(); fini.signal() }
        _ = fini.wait(timeout: .now() + 2)
    }
}
