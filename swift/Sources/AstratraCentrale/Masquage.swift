import Foundation

/// Le masquage des données sensibles avant tout envoi : mêmes règles que `@astratra/centrale/masquage`
/// (le serveur masque une seconde fois à la réception).
public enum Masquage {
    private static func regle(_ motif: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        // Les motifs sont fixes et testés : un motif invalide est une erreur de programmation.
        try! NSRegularExpression(pattern: motif, options: options)
    }

    private static let regles: [(NSRegularExpression, String)] = [
        (regle(#"\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}"#), "[jeton]"),
        (regle(#"\b(Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,8192}"#, .caseInsensitive), "$1 [jeton]"),
        (regle(#"\b(clj_(?:pub|dep|srv)_|sk-(?:proj-|ant-)?|gsk_|xaat-|AIza|ghp_|github_pat_|xox[bp]-|AKIA)[A-Za-z0-9_-]{8,512}"#), "[cle]"),
        (regle(#"\b(password|passwd|mot_?de_?passe|secret|token|api[_-]?key|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+"#, .caseInsensitive), "$1$2[masque]"),
        (regle(#"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}"#), "[email]"),
        (regle(#"\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b"#), "[iban]"),
        (regle(#"\b[a-f0-9]{32,}\b"#, .caseInsensitive), "[empreinte]"),
    ]

    private static let cartes = regle(#"(?<!\d)\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?!\d)"#)
    private static let telephones = regle(#"(?<![\w.:/-])\+?\d[\d .()-]{7,18}\d(?![\w:/-])"#)
    private static let dateIso = regle(#"^\d{4}-\d{2}-\d{2}"#)
    private static let dateCourte = regle(#"^\d{2}[./-]\d{2}[./-]\d{2,4}$"#)

    /// Masque jetons, clés, mots de passe, e-mails, IBAN, empreintes, cartes bancaires, téléphones et noms fournis.
    public static func texte(_ entree: String, noms: [String] = []) -> String {
        var resultat = entree
        for (motif, remplacement) in regles {
            if remplacement == "[email]" && !resultat.contains("@") { continue }
            resultat = remplacer(motif, dans: resultat, par: remplacement)
        }
        resultat = remplacerSi(cartes, dans: resultat) { bloc in
            let chiffres = bloc.compactMap(\.wholeNumberValue)
            var somme = 0
            for (i, chiffre) in chiffres.reversed().enumerated() {
                var n = chiffre
                if i % 2 == 1 { n *= 2; if n > 9 { n -= 9 } }
                somme += n
            }
            return somme % 10 == 0 ? "[carte]" : nil
        }
        resultat = remplacerSi(telephones, dans: resultat) { bloc in
            let chiffres = bloc.filter(\.isNumber)
            if chiffres.count < 9 || chiffres.count > 15 { return nil }
            if correspond(dateIso, bloc) || correspond(dateCourte, bloc.trimmingCharacters(in: .whitespaces)) { return nil }
            return "[telephone]"
        }
        for nom in noms {
            let propre = nom.trimmingCharacters(in: .whitespaces)
            guard propre.count >= 2 else { continue }
            let motif = regle("\\b" + NSRegularExpression.escapedPattern(for: propre) + "\\b", .caseInsensitive)
            resultat = remplacer(motif, dans: resultat, par: "[nom]")
        }
        return resultat
    }

    /// Une adresse ramenée à son gabarit : sans requête ni fragment, identifiants remplacés par `:id`.
    public static func gabarit(_ adresse: String) -> String {
        let sansFragment = adresse.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let chemin = sansFragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return chemin
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { segment -> String in
                let s = String(segment)
                return estIdentifiant(s) ? ":id" : s
            }
            .joined(separator: "/")
    }

    private static let uuid = regle(#"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#, .caseInsensitive)
    private static let objetMongo = regle(#"^[0-9a-f]{24}$"#, .caseInsensitive)
    private static let longJeton = regle(#"^[A-Za-z0-9_-]{20,}$"#)

    private static func estIdentifiant(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }
        if s.allSatisfy(\.isASCII) && s.allSatisfy(\.isNumber) { return true }
        return correspond(uuid, s) || correspond(objetMongo, s) || correspond(longJeton, s)
    }

    private static func correspond(_ motif: NSRegularExpression, _ texte: String) -> Bool {
        motif.firstMatch(in: texte, range: NSRange(texte.startIndex..., in: texte)) != nil
    }

    private static func remplacer(_ motif: NSRegularExpression, dans texte: String, par modele: String) -> String {
        motif.stringByReplacingMatches(in: texte, range: NSRange(texte.startIndex..., in: texte), withTemplate: modele)
    }

    private static func remplacerSi(_ motif: NSRegularExpression, dans texte: String, _ decider: (String) -> String?) -> String {
        var resultat = texte
        let trouves = motif.matches(in: texte, range: NSRange(texte.startIndex..., in: texte))
        for trouve in trouves.reversed() {
            guard let portee = Range(trouve.range, in: resultat) else { continue }
            if let remplacement = decider(String(resultat[portee])) {
                resultat.replaceSubrange(portee, with: remplacement)
            }
        }
        return resultat
    }
}
