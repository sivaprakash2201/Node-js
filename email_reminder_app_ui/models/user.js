const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, required: true, unique: true, trim: true },
  mailPass: { type: String, required: true }, // encrypted mail app password (AES ciphertext)
  loginPassword: { type: String, required: true } // hashed password for app login
});

module.exports = mongoose.model("User", userSchema);
