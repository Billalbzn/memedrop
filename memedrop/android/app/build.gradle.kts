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
        versionName = "1.6.0"
    }

    // Clé de signature privée, jamais commitée : la CI la reçoit via les
    // secrets GitHub (voir .github/workflows/android.yml). Toutes les builds
    // officielles sont signées avec elle, donc les mises à jour s'installent
    // par-dessus. Sans ces variables (build local), l'APK release est signé
    // avec la clé de debug d'Android Studio.
    val releaseKeystore = System.getenv("MEMEDROP_KEYSTORE")
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("MEMEDROP_KEYSTORE_PASSWORD")
                keyAlias = "memedrop"
                keyPassword = System.getenv("MEMEDROP_KEYSTORE_PASSWORD")
                storeType = "pkcs12"
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
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
