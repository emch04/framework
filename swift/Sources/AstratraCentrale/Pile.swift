import Foundation

/// La pile d'appels lue dans `Thread.callStackSymbols` (ou `NSException.callStackSymbols`).
/// Chaque ligne ressemble à « 3   MonApp   0x0000000100abc123 $s6MonApp4vueV4corpsyyF + 52 ».
enum Pile {
    /// Le module de l'application : ses cadres sont marqués `app`.
    static var moduleApp: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String ?? ProcessInfo.processInfo.processName
    }

    static func lire(_ symboles: [String], moduleApp: String = Pile.moduleApp, ignorerModule: String? = "AstratraCentrale") -> [Cadre] {
        var cadres: [Cadre] = []
        for ligne in symboles {
            let morceaux = ligne.split(separator: " ", omittingEmptySubsequences: true)
            guard morceaux.count >= 3 else { continue }
            let module = String(morceaux[1])
            if let ignorer = ignorerModule, module == ignorer { continue }
            var fonction: String?
            if morceaux.count > 3 {
                var reste = morceaux[3...].joined(separator: " ")
                if let plus = reste.range(of: " + ", options: .backwards) { reste = String(reste[..<plus.lowerBound]) }
                fonction = reste.isEmpty ? nil : String(reste.prefix(300))
            }
            cadres.append(Cadre(fichier: module, fonction: fonction, app: module == moduleApp))
            if cadres.count >= Envoi.cadresMax { break }
        }
        return cadres
    }
}
