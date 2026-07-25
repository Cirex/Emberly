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
        supportUrl: "https://emberly.app/support",
        marketingUrl: "https://emberly.app",
        privacyPolicyUrl: "https://emberly.app/privacy",
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
      notes: [
        "This is an internal tool for property maintenance staff. Every screen requires",
        "a sign-in; the demo account above is provisioned for review and shows a sample",
        "property with work orders, units and a map.",
        "",
        "Push notifications deliver emergency work-order dispatch to on-call technicians.",
        "Location is used only to order the technician's route by proximity on the property",
        "map; it is never recorded or transmitted.",
      ].join("\n"),
    },
  },
};
