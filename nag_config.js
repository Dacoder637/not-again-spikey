// NOT AGAIN: SPIKEY — release settings for the web build.
//
// This is the ONLY file you need to edit to switch ads, accounts and payments on.
// It sits next to index.html, so changing it does not need a new Godot export:
// edit, commit, push, done. Leave a value as "" to keep that feature off.
// Step-by-step setup: RELEASE_SETUP.md in the source repo.

window.NAG_CONFIG = {
  // ---- Ads (Google H5 Games Ads, through AdSense) -------------------------------
  // Your AdSense publisher id, e.g. "ca-pub-1234567890123456".
  // Empty = no ads: "watch an ad" rewards are simply given for free.
  adsenseClient: "",
  // true = Google test ads (no money, safe to click). Set false once AdSense has
  // approved your site.
  adsTestMode: true,

  // ---- Accounts, cloud saves and payments (Supabase + Flutterwave) -------------
  // Supabase → Project Settings → API: "Project URL" and the "anon public" key.
  // The anon key is meant to be public; never put the service_role key here.
  // Empty = no sign-in; progress stays in this browser only and the shop's
  // real-money items show "SOON".
  supabaseUrl: "",
  supabaseAnonKey: "",

  // true once the Flutterwave functions are deployed (RELEASE_SETUP.md step 2).
  // false = sign-in and cloud saves work, real-money items still show "SOON".
  paymentsEnabled: false,

  // Shown in the sign-in box so players know who they are trusting.
  studioName: "Dacoder637"
};
