plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "app.mullo.phone"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.mullo"
        minSdk = 30
        targetSdk = 36
        versionCode = 2 // raise for every install that should look new (launchers cache the icon per code)
        versionName = "0.1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.play.services.wearable)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.work.runtime)
    // "Continue with Google" (GoogleSignIn.kt): Android's own account sheet.
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play)
    implementation(libs.googleid)
}
