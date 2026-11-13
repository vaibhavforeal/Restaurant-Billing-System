// Windows limits paths to 260 characters unless long paths are enabled machine-wide, and the C++ codegen of
// React Native libraries makes CMake object paths far longer than that in this monorepo. A lower
// CMAKE_OBJECT_PATH_MAX makes CMake shorten long object file names with a hash instead. It must leave room for
// the 32-character hash: a value much below 250 leaves too little after the deep object folder, and CMake gives up.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// masalapos: short CMake object paths";

module.exports = function withShortCmakeObjectPaths(config) {
  return withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(MARKER)) {
      mod.modResults.contents += `
${MARKER}
android {
    defaultConfig {
        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_OBJECT_PATH_MAX=250"
            }
        }
    }
}
`;
    }
    return mod;
  });
};
