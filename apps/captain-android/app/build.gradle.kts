import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// The app follows the ForkFlow release it ships with, so the POS can offer it as an update.
val forkflowVersion = (JsonSlurper().parse(rootDir.resolve("../../package.json")) as Map<*, *>)["version"] as String
val (major, minor, patch) = forkflowVersion.substringBefore('-').split('.').map { it.toInt() }

// Release signing stays outside the repository; tools/build-captain-android.mjs passes its location.
val signing = providers.gradleProperty("forkflow.signing").orNull?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}

android {
    namespace = "app.forkflow.captain"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.forkflow.captain"
        minSdk = 24
        targetSdk = 36
        versionCode = major * 1_000_000 + minor * 1_000 + patch
        versionName = forkflowVersion
    }

    signingConfigs {
        if (signing != null) create("release") {
            storeFile = file(signing.getProperty("storeFile"))
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core:1.19.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}
