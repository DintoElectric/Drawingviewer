// GET /whoami — the UI calls this to learn who it's talking to and whether to
// show admin controls. The server is still the enforcer; this is just for UX.
const { requireUser, isAdmin, json, fail } = require("./lib/auth");
exports.handler = async (event, context) => {
  try {
    const user = requireUser(context);
    return json(200, { email: user.email, admin: isAdmin(user) });
  } catch (e) { return fail(e); }
};
