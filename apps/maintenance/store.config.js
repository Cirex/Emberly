/**
 * App Store Connect metadata, as code.
 *
 *   bunx eas-cli metadata:lint   validate this file locally (no network)
 *   bunx eas-cli metadata:pull   overwrite it from what App Store Connect has
 *   bunx eas-cli metadata:push   send it to App Store Connect
 *
 * Everything App Review reads about the app lives here rather than in a web
 * form, so an update is a diff someone can review instead of a series of
 * remembered edits.
 *
 * A .js file, not .json, on purpose: the review section needs a working login,
 * and credentials must not be committed. They are read from the environment and
 * the file fails loudly when they are missing at push time.
 *
 * Required in the environment when running metadata:push —
 *   ASC_REVIEW_EMAIL, ASC_REVIEW_PHONE, ASC_REVIEW_FIRST_NAME, ASC_REVIEW_LAST_NAME
 *   ASC_DEMO_USERNAME, ASC_DEMO_PASSWORD   (a dedicated review account, never a
 *                                           real staff member's ResMan login)
 *   ASC_SUPPORT_URL, ASC_PRIVACY_POLICY_URL (must RESOLVE — Apple rejects a dead
 *                                           privacy-policy link)
 *   ASC_MARKETING_URL                       (optional)
 */

/** Fail at push time rather than silently shipping an empty review section. */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `store.config.js: ${name} is required to push metadata. ` +
        `See the header of this file for the full list.`,
    );
  }
  return value.trim();
}

module.exports = {
  configVersion: 0,
  apple: {
    info: {
      "en-US": {
        title: "Emberly Maintenance",
        subtitle: "Work orders for property techs",
        description: [
          "Emberly Maintenance is the field tool for property maintenance technicians.",
          "",
          "Work orders sync from the property management system and stay on the device, so the",
          "board still works in a basement or a parking garage. Anything recorded offline is",
          "queued and sent when the signal returns.",
          "",
          "• Today and My Week views of assigned work",
          "• Unit and property map with utility shutoffs marked",
          "• Photos before and after, with markup",
          "• Voice dictation for completion notes",
          "• Spanish translation of work-order text",
          "• Preventive maintenance rounds",
          "",
          "Emberly Maintenance requires an account provided by your employer.",
        ].join("\n"),
        keywords: [
          "maintenance",
          "work orders",
          "property",
          "facilities",
          "technician",
          "apartments",
        ],
        releaseNotes: "Faster work-order sync and reliability fixes.",
        // Read from the environment, NOT hardcoded. Apple requires a working
        // privacy-policy URL and rejects a dead one, and neither page exists
        // yet — apps/web has no /privacy or /support route. The production
        // origin is https://emberly.krkn.app (packages/core PRODUCTION_ORIGIN),
        // so these will likely be pages there, but they have to exist before
        // this is pushed. Forcing them through required() means a push cannot
        // quietly send Apple a 404.
        supportUrl: required("ASC_SUPPORT_URL"),
        marketingUrl: process.env.ASC_MARKETING_URL || undefined,
        privacyPolicyUrl: required("ASC_PRIVACY_POLICY_URL"),
      },
    },
    categories: ["BUSINESS", "PRODUCTIVITY"],
    copyright: `${new Date().getFullYear()} Emberly`,
    advisory: {
      // Every field the schema requires, answered explicitly. A work-order tool
      // for staff has nothing to declare, but "we considered it and the answer
      // is none" is worth more than an omission when the rating is questioned.
      alcoholTobaccoOrDrugUseOrReferences: "NONE",
      contests: "NONE",
      gambling: false,
      gamblingSimulated: "NONE",
      medicalOrTreatmentInformation: "NONE",
      profanityOrCrudeHumor: "NONE",
      sexualContentGraphicAndNudity: "NONE",
      sexualContentOrNudity: "NONE",
      horrorOrFearThemes: "NONE",
      matureOrSuggestiveThemes: "NONE",
      violenceCartoonOrFantasy: "NONE",
      violenceRealisticProlongedGraphicOrSadistic: "NONE",
      violenceRealistic: "NONE",
      // The app opens no arbitrary web content.
      unrestrictedWebAccess: false,
      // Not a kids-category app — it requires an employer-issued account.
      kidsAgeBand: null,
      seventeenPlus: false,
      ageRatingOverride: "NONE",
      koreaAgeRatingOverride: "NONE",
    },
    review: {
      firstName: required("ASC_REVIEW_FIRST_NAME"),
      lastName: required("ASC_REVIEW_LAST_NAME"),
      email: required("ASC_REVIEW_EMAIL"),
      phone: required("ASC_REVIEW_PHONE"),
      // THE most common rejection for this app's shape: every screen is behind a
      // sign-in, so App Review sees a login wall and nothing else without these.
      demoRequired: true,
      demoUsername: required("ASC_DEMO_USERNAME"),
      demoPassword: required("ASC_DEMO_PASSWORD"),
      // Kept to what is verifiable. An earlier draft of this file told Apple
      // that location was used to order the technician's route by proximity —
      // the app does not use location AT ALL (expo-location is never imported).
      // A false claim about data handling in review notes is not a small thing,
      // so nothing goes in here that cannot be pointed at in the code.
      notes: [
        "This is an internal tool for property maintenance staff at a single property",
        "management company. Every screen is behind a sign-in, so the demo account above",
        "is required to see anything past the login screen.",
        "",
        "Push notifications are used for one thing: dispatching emergency work orders to",
        "on-call technicians.",
        "",
        "Camera and photo library are used to attach before/after photos to a work order.",
        "Microphone and speech recognition are used only for dictating completion notes;",
        "transcription is on-device.",
      ].join("\n"),
    },
  },
};
