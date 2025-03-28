const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password) {
            return res.status(400).json({ msg: "Faltan datos" });
        }

        let user = await User.findOne({ username });
        if (user) return res.status(400).json({ msg: "Usuario ya registrado" });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = new User({ username, password: hashedPassword, role: role || 'user' });
        await user.save();

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || "default_secret", { expiresIn: "1h" });

        res.status(201).json({ msg: "Usuario registrado" });
    } catch (err) {
        res.status(500).json({ msg: "Error del servidor" });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ msg: "Faltan datos" });
        }

        let user = await User.findOne({ username });
        if (!user) return res.status(400).json({ msg: "Credenciales incorrectas" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ msg: "Credenciales incorrectas" });

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });

        res.json({ msg: "Login exitoso", token });
    } catch (err) {
        res.status(500).json({ msg: "Error del servidor" });
    }
};