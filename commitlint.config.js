// Commit titles are plain English so anyone, including non-developers, can read the history.
// Example: "Add phone number sign-in with one-time codes"
export default {
  rules: {
    "header-min-length": [2, "always", 10],
    "header-max-length": [2, "always", 72],
    "header-full-stop": [2, "never", "."],
    "body-leading-blank": [2, "always"],
  },
};
