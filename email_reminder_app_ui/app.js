require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const CryptoJS = require('crypto-js');

const User = require('./models/user');
const Reminder = require('./models/reminder');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ✅ Set a default title for all views
app.use((req, res, next) => {
  res.locals.title = 'Email Reminder';
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({ secret: process.env.SESSION_SECRET || 'change_this', resave:false, saveUninitialized:false }));

mongoose.connect(process.env.MONGODB_URI).then(()=>console.log('Connected to MongoDB')).catch(e=>console.error('MongoDB error',e));

const AES_KEY = process.env.AES_SECRET_KEY || '';
function encryptMailPass(plain){ return CryptoJS.AES.encrypt(plain, AES_KEY).toString(); }
function decryptMailPass(cipher){ try{ const bytes = CryptoJS.AES.decrypt(cipher, AES_KEY); return bytes.toString(CryptoJS.enc.Utf8); }catch(e){ return null; } }

function isValidEmail(email){ if(!email) return false; const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; return re.test(email); }

app.use(async (req,res,next)=>{ res.locals.currentUser = null; if(req.session && req.session.userId){ try{ const user = await User.findById(req.session.userId).select('-mailPass'); if(user) res.locals.currentUser = user; }catch(e){} } next(); });

app.get('/', (req,res)=>res.render('index',{title:'Home'}));

app.get('/about',(req,res)=>res.render('about',{title:'About'}));

app.get('/register',(req,res)=>res.render('register',{title:'Register'}));
app.post('/register', async (req,res)=>{
  try{
    const { name, email, mailPass, loginPassword } = req.body;
    if(!email||!mailPass||!loginPassword) return res.render('register',{error:'All fields required.'});
    if(!isValidEmail(email)) return res.render('register',{error:'Invalid email.'});
    const existing = await User.findOne({ email });
    if(existing) return res.render('register',{error:'Email already registered.'});
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(loginPassword, salt);
    const encrypted = encryptMailPass(mailPass);
    const user = new User({ name, email, mailPass: encrypted, loginPassword: hashed });
    await user.save();
    req.session.userId = user._id;
    return res.redirect('/reminders');
  }catch(e){ console.error('Register error',e); return res.render('register',{error:'Server error.'}); }
});

app.get('/login',(req,res)=>res.render('login',{title:'Login'}));
app.post('/login', async (req,res)=>{
  try{
    const { email, password } = req.body;
    if(!email||!password) return res.render('login',{error:'Email and password required.'});
    const user = await User.findOne({ email });
    if(!user) return res.render('login',{error:'No account found with that email.'});
    const ok = await bcrypt.compare(password, user.loginPassword);
    if(!ok) return res.render('login',{error:'Wrong password. Please try again.'});
    req.session.userId = user._id;
    return res.redirect('/reminders');
  }catch(e){ console.error('Login error',e); return res.render('login',{error:'Server error.'}); }
});

app.post('/logout',(req,res)=>{ req.session.destroy(()=>res.redirect('/')); });

function isAuthenticated(req,res,next){ if(req.session && req.session.userId) return next(); return res.redirect('/login'); }

app.get('/reminders', isAuthenticated, async (req,res)=>{
  try{ const reminders = await Reminder.find({ user: req.session.userId, deleted: {$ne:true} }).sort({ scheduledTime:1 }); res.render('reminders',{reminders}); }catch(e){ console.error(e); res.render('reminders',{reminders:[], error:'Failed to load.'}); }
});

app.post('/reminders/:id/delete', isAuthenticated, async (req,res)=>{
  try{ const id=req.params.id; const rem=await Reminder.findOne({_id:id,user:req.session.userId}); if(!rem) return res.redirect('/reminders'); rem.deleted=true; await rem.save(); return res.redirect('/reminders'); }catch(e){ console.error(e); return res.redirect('/reminders'); }
});

app.get('/schedule', isAuthenticated, (req,res)=>res.render('schedule',{title:'Schedule'}));
app.post('/schedule', isAuthenticated, async (req,res)=>{
  try{
    const { message, datetime, email } = req.body;
    if(!message||!datetime) return res.render('schedule',{error:'Message and date/time required.'});
    if(email){
      const list = email.split(',').map(s=>s.trim()).filter(Boolean);
      for(const e of list){ if(!isValidEmail(e)) return res.render('schedule',{error:'One or more recipient emails are invalid.'}); }
    }
    const reminder = new Reminder({ user: req.session.userId, email: email||undefined, message, scheduledTime: new Date(datetime) });
    await reminder.save();
    return res.redirect('/schedule?success=1');
  }catch(e){ console.error('Schedule error',e); return res.render('schedule',{error:'Server error scheduling.'}); }
});

cron.schedule('* * * * *', async ()=>{
  try{
    const now = new Date();
    const reminders = await Reminder.find({ scheduledTime: {$lte: now}, sent:false, deleted: {$ne:true} }).populate('user');
    for(const rem of reminders){
      if(!rem.user) continue;
      const decrypted = decryptMailPass(rem.user.mailPass);
      if(!decrypted){ console.error('Cannot decrypt mailPass for user', rem.user._id); continue; }
      try{
        const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user: rem.user.email, pass: decrypted } });
        const to = rem.email ? rem.email.split(',').map(s=>s.trim()).filter(Boolean) : [rem.user.email];
        await transporter.sendMail({ from: rem.user.email, to, subject:'Reminder', text: rem.message });
        rem.sent = true; await rem.save();
        console.log('Sent reminder', rem._id);
      }catch(mailErr){ console.error('Mail error', mailErr && mailErr.message); }
    }
  }catch(e){ console.error('Cron error', e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server started on', PORT));
