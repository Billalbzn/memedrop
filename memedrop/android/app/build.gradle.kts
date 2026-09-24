plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Le rendu des drops réutilise tel quel le code de l'overlay Windows
// (overlay/src) : on le copie dans les assets à chaque build, en insérant
// android-shim.js qui remplace l'API Electron `window.memedrop`.
val webAssetsDir = layout.buildDirectory.dir("generated/webassets")
val syncWebAssets = tasks.register<Copy>("syncWebAssets") {
    val src = rootProject.file("../overlay/src")
    from(src) { include("overlay.js", "styles.css") }
    from(src) {
        include("overlay.html")
        filter { line: String ->
            line.replace(
                "<script src=\"./overlay.js\"></script>",
                "<script src=\"./android-shim.js\"></script><script src=\"./overlay.js\"></script>",
            )
        }
    }
    into(webAssetsDir)
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }

android {
    namespace = "com.memedrop.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.memedrop.app"
        minSdk = 26
        targetSdk = 34
        // Chaque build CI a un numéro plus grand → l'APK s'installe par-dessus
        // la version précédente sans désinstaller.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.5.2"
    }

    // Clé de signature partagée (commitée) : toutes les builds sont signées
    // pareil, donc les mises à jour s'installent par-dessus. Ce n'est PAS une
    // clé de publication Play Store.
    signingConfigs {
        create("shared") {
            storeFile = file("memedrop-shared.keystore")
            storePassword = "memedrop"
            keyAlias = "memedrop"
            keyPassword = "memedrop"
            storeType = "pkcs12"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(webAssetsDir)
        }
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
