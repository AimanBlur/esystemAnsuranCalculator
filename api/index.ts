import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import nodemailer from 'nodemailer';

// --- DATABASE (Resets on server restart/sleep) ---
let phoneDatabase = [
    { id: 1, model: "iPhone 15", rrp: 3499 },
    { id: 2, model: "Samsung S24", rrp: 4099 }
];

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// FIX: Initialize with empty constructor
const app = new Elysia()
    .use(cors())
    // FIX: Use .group to handle the '/api' prefix safely
    .group('/api', app => app
        .get('/phones', () => phoneDatabase)
        .post('/phones', ({ body }) => {
            const newPhone = { id: phoneDatabase.length + 1, ...body };
            phoneDatabase.push(newPhone);
            return { success: true };
        }, {
            body: t.Object({ model: t.String(), rrp: t.Number() })
        })
        .post('/submit-application', async ({ body }) => {
            const emailBody = `
                BORANG PERMOHONAN ANSURAN BARU
                ===============================
                NAMA : ${body.nama}
                KAD PENGENALAN : ${body.ic}
                ALAMAT : ${body.alamat}
                TAHUN TINGGAL: ${body.tahun_tinggal}
                RUMAH : ${body.jenis_rumah}
                STATUS : ${body.status}
                ANAK : ${body.anak}
                HP : ${body.hp}
                EMEL : ${body.email_user}
                TARIKH GAJI : ${body.tarikh_gaji}

                BUTIRAN KERJA
                NAMA SYARIKAT : ${body.syarikat}
                ALAMAT : ${body.alamat_kerja}
                TAHUN BEKERJA: ${body.tahun_kerja}
                NO PEJABAT : ${body.no_pejabat}
                JAWATAN : ${body.jawatan}

                RUJUKAN 1
                NAMA : ${body.ref1_nama}
                HUBUNGAN : ${body.ref1_hub}
                HP : ${body.ref1_hp}

                RUJUKAN 2
                NAMA : ${body.ref2_nama}
                HUBUNGAN : ${body.ref2_hub}
                HP : ${body.ref2_hp}

                BUTIRAN BANK
                BANK : ${body.bank_nama}
                AKAUN : ${body.bank_acc}
            `;

            const mailOptions = {
                from: process.env.GMAIL_USER,
                to: 'amenohoshizora@gmail.com', // Your Boss's Email
                replyTo: body.email_user,
                subject: `PERMOHONAN BARU - ${body.nama}`,
                text: emailBody,
                attachments: [
                    { filename: `IC_${body.nama}.png`, content: Buffer.from(await body.icFile.arrayBuffer()) },
                    { filename: `SlipGaji_${body.nama}.png`, content: Buffer.from(await body.salarySlip.arrayBuffer()) }
                ]
            };

            await transporter.sendMail(mailOptions);
            return { success: true };
        }, {
            body: t.Object({
                nama: t.String(),
                ic: t.String(),
                alamat: t.String(),
                tahun_tinggal: t.String(),
                jenis_rumah: t.String(),
                status: t.String(),
                anak: t.String(),
                hp: t.String(),
                email_user: t.String(),
                tarikh_gaji: t.String(),
                syarikat: t.String(),
                alamat_kerja: t.String(),
                tahun_kerja: t.String(),
                no_pejabat: t.String(),
                jawatan: t.String(),
                ref1_nama: t.String(),
                ref1_alamat: t.String(),
                ref1_hub: t.String(),
                ref1_hp: t.String(),
                ref2_nama: t.String(),
                ref2_alamat: t.String(),
                ref2_hub: t.String(),
                ref2_hp: t.String(),
                bank_nama: t.String(),
                bank_acc: t.String(),
                icFile: t.File(),
                salarySlip: t.File()
            })
        })
    );

export default app;
