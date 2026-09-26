const express = require("express");
const multer = require("multer");
const JSZip = require("jszip");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const BUILDS = path.join(ROOT, "builds");
const PROJECTS = path.join(ROOT, "projects");
const TEMPLATES = path.join(ROOT, "templates");
const TMP = path.join(ROOT, ".tmp");

for (const dir of [
  PUBLIC,
  BUILDS,
  PROJECTS,
  TEMPLATES,
  TMP
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.json({
  limit: "10mb"
}));

app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(PUBLIC));

/* =========================================================
   HELPERS
========================================================= */

function safeName(value, fallback = "zlez-app") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || fallback;
}

function validPackageName(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(value);
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function javaEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, {
    recursive: true
  });
}

function writeFile(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {

    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {

        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr
        });
      }
    );

  });
}

function getGradleCommand() {

  if (process.platform === "win32") {
    return "gradle.bat";
  }

  return "gradle";
}

function cleanDir(dir) {

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, {
      recursive: true,
      force: true
    });
  }

  fs.mkdirSync(dir, {
    recursive: true
  });
}

/* =========================================================
   ZIP WEBSITE EXTRACTION
========================================================= */

async function extractWebsite(buffer, destination) {

  const zip = await JSZip.loadAsync(buffer);

  const entries = Object.keys(zip.files);

  for (const entryName of entries) {

    const entry = zip.files[entryName];

    if (entry.dir) {
      continue;
    }

    let clean = entryName
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    const parts = clean.split("/");

    if (
      parts.includes("..") ||
      clean.startsWith("../") ||
      clean.includes("/../")
    ) {
      throw new Error(
        "ZIP mengandung path yang tidak aman."
      );
    }

    const output = path.resolve(
      destination,
      clean
    );

    if (
      output !== path.resolve(destination) &&
      !output.startsWith(
        path.resolve(destination) + path.sep
      )
    ) {
      throw new Error(
        "ZIP mencoba keluar dari folder project."
      );
    }

    ensureDir(path.dirname(output));

    const data =
      await entry.async("nodebuffer");

    fs.writeFileSync(
      output,
      data
    );
  }
}

/* =========================================================
   ANDROID PROJECT
========================================================= */

function packagePath(packageName) {
  return packageName.split(".").join(path.sep);
}

function createAndroidProject(config, webDir, outputDir) {

  const pkg = config.packageName;
  const appName = config.appName;
  const versionName = config.versionName;
  const versionCode = config.versionCode;

  const javaPackage =
    pkg.split(".").join(".");

  const javaDir = path.join(
    outputDir,
    "app",
    "src",
    "main",
    "java",
    packagePath(pkg)
  );

  const resDir = path.join(
    outputDir,
    "app",
    "src",
    "main",
    "res"
  );

  const assetsDir = path.join(
    outputDir,
    "app",
    "src",
    "main",
    "assets",
    "web"
  );

  ensureDir(javaDir);
  ensureDir(resDir);
  ensureDir(assetsDir);

  /* ---------------------------------------------
     settings.gradle
  --------------------------------------------- */

  writeFile(
    path.join(outputDir, "settings.gradle"),
`pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ZlezGenerated"
include(":app")
`
  );

  /* ---------------------------------------------
     root build.gradle
  --------------------------------------------- */

  writeFile(
    path.join(outputDir, "build.gradle"),
`plugins {
    id 'com.android.application' version '8.7.3' apply false
}
`
  );

  /* ---------------------------------------------
     gradle.properties
  --------------------------------------------- */

  writeFile(
    path.join(outputDir, "gradle.properties"),
`org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
android.nonTransitiveRClass=true
`
  );

  /* ---------------------------------------------
     app build.gradle
  --------------------------------------------- */

  const adsEnabled =
    !!config.ads.enabled;

  const dependencies = adsEnabled
    ? `
    implementation 'com.google.android.gms:play-services-ads:24.6.0'
`
    : "";

  writeFile(
    path.join(
      outputDir,
      "app",
      "build.gradle"
    ),
`plugins {
    id 'com.android.application'
}

android {
    namespace '${pkg}'
    compileSdk 35

    defaultConfig {
        applicationId '${pkg}'
        minSdk 23
        targetSdk 35
        versionCode ${versionCode}
        versionName '${versionName}'
    }

    buildTypes {
        debug {
            minifyEnabled false
        }

        release {
            minifyEnabled false
            shrinkResources false
        }
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.7.0'
    implementation 'androidx.webkit:webkit:1.12.1'
${dependencies}
}
`
  );

  /* ---------------------------------------------
     Manifest
  --------------------------------------------- */

  let permissions = `
    <uses-permission android:name="android.permission.INTERNET" />
`;

  if (config.permissions.camera) {
    permissions += `
    <uses-permission android:name="android.permission.CAMERA" />
`;
  }

  if (config.permissions.microphone) {
    permissions += `
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
`;
  }

  if (config.permissions.notifications) {
    permissions += `
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
`;
  }

  if (config.permissions.location) {
    permissions += `
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
`;
  }

  const adsMeta = adsEnabled
    ? `
        <meta-data
            android:name="com.google.android.gms.ads.APPLICATION_ID"
            android:value="${xmlEscape(config.ads.appId || "ca-app-pub-3940256099942544~3347511713")}" />
`
    : "";

  writeFile(
    path.join(
      outputDir,
      "app",
      "src",
      "main",
      "AndroidManifest.xml"
    ),
`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${permissions}
    <application
        android:allowBackup="true"
        android:label="${xmlEscape(appName)}"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="true">

${adsMeta}

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

    </application>
</manifest>
`
  );

  /* ---------------------------------------------
     Theme
  --------------------------------------------- */

  const valuesDir =
    path.join(resDir, "values");

  ensureDir(valuesDir);

  writeFile(
    path.join(valuesDir, "styles.xml"),
`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme"
        parent="Theme.AppCompat.Light.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:colorAccent">#111827</item>
        <item name="android:navigationBarColor">#000000</item>
        <item name="android:statusBarColor">#000000</item>
    </style>
</resources>
`
  );

  /* ---------------------------------------------
     WebView Activity
  --------------------------------------------- */

  const adUnit =
    config.ads.adUnitId ||
    "ca-app-pub-3940256099942544/6300978111";

  const adCode = adsEnabled
    ? `
        MobileAds.initialize(
            this,
            status -> {}
        );

        AdView adView = new AdView(this);
        adView.setAdSize(AdSize.BANNER);
        adView.setAdUnitId("${javaEscape(adUnit)}");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        root.addView(webView,
            new LinearLayout.LayoutParams(
                -1,
                0,
                1
            )
        );

        root.addView(adView,
            new LinearLayout.LayoutParams(
                -1,
                60
            )
        );

        setContentView(root);

        adView.loadAd(
            new AdRequest.Builder().build()
        );
`
    : `
        setContentView(webView);
`;

  writeFile(
    path.join(
      javaDir,
      "MainActivity.java"
    ),
`package ${javaPackage};

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;

import androidx.appcompat.app.AppCompatActivity;

${adsEnabled ? `
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.MobileAds;
` : ""}

public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        super.onCreate(savedInstanceState);

        WebView webView =
            new WebView(this);

        webView.setWebViewClient(
            new WebViewClient()
        );

        WebSettings settings =
            webView.getSettings();

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.loadUrl(
            "file:///android_asset/web/index.html"
        );

${adCode}
    }
}
`
  );

  /* ---------------------------------------------
     Copy website
  --------------------------------------------- */

  copyRecursive(
    webDir,
    assetsDir
  );

  /* ---------------------------------------------
     Launcher icon
  --------------------------------------------- */

  if (config.iconBuffer) {

    const iconDirs = [
      "mipmap-mdpi",
      "mipmap-hdpi",
      "mipmap-xhdpi",
      "mipmap-xxhdpi",
      "mipmap-xxxhdpi"
    ];

    for (const dir of iconDirs) {

      const iconDir =
        path.join(resDir, dir);

      ensureDir(iconDir);

      fs.writeFileSync(
        path.join(iconDir, "ic_launcher.png"),
        config.iconBuffer
      );

      fs.writeFileSync(
        path.join(iconDir, "ic_launcher_round.png"),
        config.iconBuffer
      );
    }

  }

  return outputDir;
}

function copyRecursive(source, destination) {

  ensureDir(destination);

  const items =
    fs.readdirSync(source);

  for (const item of items) {

    const src =
      path.join(source, item);

    const dest =
      path.join(destination, item);

    const stat =
      fs.statSync(src);

    if (stat.isDirectory()) {

      copyRecursive(
        src,
        dest
      );

    } else {

      fs.copyFileSync(
        src,
        dest
      );

    }
  }
}

/* =========================================================
   API
========================================================= */

app.get("/api/health", (req, res) => {

  res.json({
    ok: true,
    service: "Zlez.Id Pro",
    time: new Date().toISOString()
  });

});

/*
  Create/build APK.
*/
app.post(
  "/api/build",
  upload.fields([
    {
      name: "website",
      maxCount: 1
    },
    {
      name: "icon",
      maxCount: 1
    }
  ]),
  async (req, res) => {

    let buildId = null;

    try {

      const body = req.body;

      const appName =
        String(body.appName || "Zlez App")
          .trim()
          .slice(0, 50);

      const packageName =
        String(
          body.packageName ||
          "id.zlez.app"
        ).trim();

      const versionName =
        String(
          body.versionName ||
          "1.0.0"
        ).trim();

      const versionCode =
        Number(
          body.versionCode || 1
        );

      if (!validPackageName(packageName)) {

        return res.status(400).json({
          ok: false,
          error:
            "Package name tidak valid. Contoh: id.zlez.myapp"
        });

      }

      if (
        !Number.isInteger(versionCode) ||
        versionCode < 1
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Version code harus berupa angka >= 1."
        });

      }

      const website =
        req.files &&
        req.files.website &&
        req.files.website[0];

      if (!website) {

        return res.status(400).json({
          ok: false,
          error:
            "Upload website ZIP terlebih dahulu."
        });

      }

      const icon =
        req.files &&
        req.files.icon &&
        req.files.icon[0];

      if (
        icon &&
        ![
          "image/png",
          "image/webp",
          "image/jpeg"
        ].includes(icon.mimetype)
      ) {

        return res.status(400).json({
          ok: false,
          error:
            "Icon harus PNG, JPG, atau WEBP."
        });

      }

      buildId =
        crypto.randomBytes(8)
          .toString("hex");

      const buildDir =
        path.join(
          BUILDS,
          buildId
        );

      const webDir =
        path.join(
          buildDir,
          "website"
        );

      const androidDir =
        path.join(
          buildDir,
          "android"
        );

      ensureDir(webDir);
      ensureDir(androidDir);

      await extractWebsite(
        website.buffer,
        webDir
      );

      const indexPath =
        path.join(
          webDir,
          "index.html"
        );

      if (!fs.existsSync(indexPath)) {

        return res.status(400).json({
          ok: false,
          error:
            "ZIP website harus memiliki index.html di root."
        });

      }

      const config = {

        appName,

        packageName,

        versionName,

        versionCode,

        permissions: {
          camera: body.permissionCamera === "true",
          microphone: body.permissionMicrophone === "true",
          notifications: body.permissionNotifications === "true",
          location: body.permissionLocation === "true"
        },

        ads: {
          enabled: body.adsEnabled === "true",
          appId: String(
            body.adsAppId || ""
          ).trim(),
          adUnitId: String(
            body.adsAdUnitId || ""
          ).trim()
        },

        iconBuffer: icon
          ? icon.buffer
          : null
      };

      createAndroidProject(
        config,
        webDir,
        androidDir
      );

      const gradle =
        getGradleCommand();

      /*
        assembleDebug menghasilkan APK yang
        sudah ditandatangani debug oleh Android Gradle Plugin.
      */
      const result =
        await run(
          gradle,
          [
            "assembleDebug",
            "--no-daemon"
          ],
          androidDir
        );

      const apkPath =
        path.join(
          androidDir,
          "app",
          "build",
          "outputs",
          "apk",
          "debug",
          "app-debug.apk"
        );

      if (!fs.existsSync(apkPath)) {

        return res.status(500).json({
          ok: false,
          error:
            "Gradle selesai tetapi APK tidak ditemukan.",
          output:
            result.stdout.slice(-5000),
          errorOutput:
            result.stderr.slice(-5000)
        });

      }

      const finalName =
        safeName(appName) +
        "-" +
        versionName.replace(
          /[^a-zA-Z0-9._-]/g,
          "-"
        ) +
        ".apk";

      const finalPath =
        path.join(
          BUILDS,
          finalName
        );

      fs.copyFileSync(
        apkPath,
        finalPath
      );

      res.json({
        ok: true,
        message:
          "APK berhasil dibuat.",
        download:
          "/downloads/" +
          encodeURIComponent(finalName),
        appName,
        packageName,
        versionName,
        versionCode
      });

      /*
        Bersihkan folder kerja setelah
        APK berhasil disalin.
      */
      setTimeout(() => {

        fs.rm(
          buildDir,
          {
            recursive: true,
            force: true
          },
          () => {}
        );

      }, 5000);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Build gagal.",
        stdout:
          error.stdout
            ? error.stdout.slice(-8000)
            : "",
        stderr:
          error.stderr
            ? error.stderr.slice(-8000)
            : ""
      });

    }

  }
);

/* =========================================================
   DOWNLOADS
========================================================= */

app.get(
  "/downloads/:file",
  (req, res) => {

    const filename =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        BUILDS,
        filename
      );

    if (!fs.existsSync(file)) {

      return res.status(404).send(
        "APK tidak ditemukan."
      );

    }

    res.download(
      file,
      filename
    );
  }
);

/* =========================================================
   TEMPLATE API
========================================================= */

const templates = [
  {
    id: "zlez-clean",
    name: "Zlez Clean WebView",
    description:
      "Template WebView sederhana untuk website.",
    type: "builtin"
  },
  {
    id: "zlez-dark",
    name: "Zlez Dark WebView",
    description:
      "Template WebView dengan tema gelap.",
    type: "builtin"
  }
];

app.get(
  "/api/templates",
  (req, res) => {

    res.json({
      ok: true,
      templates
    });

  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("=================================");
    console.log("       ZLEZ.ID PRO BUILDER       ");
    console.log("=================================");
    console.log("");
    console.log(
      `Server: http://127.0.0.1:${PORT}`
    );
    console.log("");
    console.log(
      "Pastikan Java 17+ dan Gradle 8.9+ tersedia."
    );
    console.log("");

  }
);
