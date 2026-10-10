// swift-tools-version: 6.0
// Les paquets Swift d'Astratra (les paquets npm sont dans packages/).
import PackageDescription

let package = Package(
    name: "Astratra",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        // Collecte des erreurs, sessions, écrans et appels d'IA vers un serveur Centrale
        // (même format d'envoi que @astratra/centrale).
        .library(name: "AstratraCentrale", targets: ["AstratraCentrale"])
    ],
    targets: [
        .target(name: "AstratraCentrale", path: "swift/Sources/AstratraCentrale"),
        .testTarget(name: "AstratraCentraleTests", dependencies: ["AstratraCentrale"], path: "swift/Tests/AstratraCentraleTests"),
    ]
)
