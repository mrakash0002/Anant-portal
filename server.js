const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

// Supabase client (backend only - use service role key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '24h';

// Middleware: Verify JWT
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ============ AUTH ENDPOINTS ============

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Fetch worker from Supabase
    const { data, error } = await supabase
      .from('workers_registry')
      .select('id, email, name, role, fixed_salary, morning_advance, salary_advance_taken, created_at')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !data) return res.status(401).json({ error: 'Invalid email or password' });

    // Verify password (hashed in DB)
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password
    });

    if (authError || !authData.session) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT for frontend
    const token = jwt.sign({ id: data.id, email: data.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({
      token,
      user: {
        id: data.id,
        email: data.email,
        name: data.name,
        role: data.role,
        fixed_salary: data.fixed_salary,
        morning_advance: data.morning_advance,
        salary_advance_taken: data.salary_advance_taken
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout (client-side: just delete token)
app.post('/api/auth/logout', authMiddleware, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// ============ PROTECTED ENDPOINTS ============

// Get worker details
app.get('/api/worker/profile', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('workers_registry')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get shift logs
app.get('/api/shifts', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shift_logs')
      .select('*')
      .eq('worker_email', req.user.email)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Shifts fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// Create shift (punch in)
app.post('/api/shifts', authMiddleware, async (req, res) => {
  try {
    const { site_location, progress_notes, ...payload } = req.body;
    const { data, error } = await supabase
      .from('shift_logs')
      .insert([{
        worker_email: req.user.email,
        worker_id: req.user.id,
        status: 'Active',
        punch_in_time: new Date().toISOString(),
        site_location: site_location || 'Not Specified',
        progress_notes: progress_notes || '',
        ...payload
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Shift creation error:', err);
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// Update shift (punch out)
app.patch('/api/shifts/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shift_logs')
      .update({
        ...req.body,
        punch_out_time: new Date().toISOString(),
        status: 'Pending'
      })
      .eq('id', req.params.id)
      .eq('worker_id', req.user.id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Shift update error:', err);
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

// Update worker wallet balance
app.patch('/api/worker/wallet', authMiddleware, async (req, res) => {
  try {
    const { morning_advance } = req.body;
    const { data, error } = await supabase
      .from('workers_registry')
      .update({ morning_advance })
      .eq('id', req.user.id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Wallet update error:', err);
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

// ============ SECURE IMAGE UPLOAD (uses Supabase Storage with auth) ============

app.post('/api/upload-selfie', authMiddleware, async (req, res) => {
  try {
    const { image, shiftId, type } = req.body; // type: 'in' or 'out'
    
    if (!image || !shiftId || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Remove data:image/jpeg;base64, prefix
    const base64Data = image.split(',')[1] || image;
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Upload to Supabase Storage (private bucket)
    const fileName = `${req.user.id}/${shiftId}/${type}-${Date.now()}.jpg`;
    const { error: uploadError, data: uploadData } = await supabase.storage
      .from('shift_selfies')
      .upload(fileName, buffer, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (uploadError) throw uploadError;

    res.json({ path: uploadData.path, url: `${process.env.SUPABASE_URL}/storage/v1/object/authenticated/shift_selfies/${uploadData.path}` });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Get signed URL for image (protected by JWT)
app.get('/api/selfie/:path(*)', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.storage
      .from('shift_selfies')
      .createSignedUrl(req.params.path, 3600); // 1-hour expiry

    if (error) throw error;
    res.json({ url: data.signedUrl });
  } catch (err) {
    console.error('Signed URL error:', err);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Secure backend running on port ${PORT}`));
