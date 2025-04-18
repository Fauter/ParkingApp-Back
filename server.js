require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes.js');
const vehiculoRoutes = require('./routes/vehiculoRoutes'); 
const tipoVehiculoRoutes = require('./routes/tipoVehiculoRoutes');
const movimientoRoutes = require('./routes/movimientoRoutes');
const tarifaRoutes = require('./routes/tarifaRoutes');
const preciosRoutes = require('./routes/precios');


const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ Conectado a MongoDB Atlas"))
.catch(err => console.error("❌ Error conectando a MongoDB:", err));

app.use('/api/auth', authRoutes);
app.use('/api/vehiculos', vehiculoRoutes);
app.use('/api/tipos-vehiculo', tipoVehiculoRoutes);
app.use('/api/movimientos', movimientoRoutes);
app.use('/api/tarifas', tarifaRoutes); 
app.use('/api/precios', preciosRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`));