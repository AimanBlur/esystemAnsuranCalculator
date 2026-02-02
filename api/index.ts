import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import nodemailer from 'nodemailer';
import postgres from 'postgres';

let sql: any;
try {
    if (!process.env.DATABASE_URL) {
        console.error("❌ ERROR: DATABASE_URL is missing!");
    } else {
        // Connect to Supabase
        sql = postgres(process.env.DATABASE_URL, { 
            ssl: 'require', 
            prepare: false // FIX: Supabase transaction poolers often need this
        });
    }
} catch (err) {
    console.error("❌ Database Connection Failed:", err);
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

const app = new Elysia()
    .use(cors())
    .group('/api', app => app
        .get('/phones', async () => {
            if (!sql) return { error: "Database not connected. Check Vercel Logs." };
            
            try {
                const phones = await sql`SELECT * FROM phones ORDER BY id DESC`;
                
                // FIX: Convert the special SQL list into a normal JavaScript Array
                // Using [...phones] forces it to be a plain list
                return [...phones]; 
                
            } catch (error: any) {
                console.error("SQL Error:", error);
                return { error: error.message || "Database Query Failed" }; 
            }
        })

        .post('/phones', async ({ body, headers, set }) => {
            // FIX: Return 500 error if DB is missing
            if (!sql) {
                set.status = 500;
                return { success: false, message: "Database not connected (Check Vercel Logs)" };
            }

            try {
                const adminPass = headers['admin-secret'];
                if (adminPass !== process.env.ADMIN_PASSWORD) {
                    set.status = 401; 
                    return { success: false, message: "Wrong Admin Password" };
                }

                await sql`
                    INSERT INTO phones (model, rrp) 
                    VALUES (${(body as any).model}, ${(body as any).rrp})
                `;
                return { success: true };
            } catch (error: any) {
                console.error("Insert Error:", error);
                set.status = 500; // FIX: Tell frontend this failed
                return { success: false, message: "DB Error: " + error.message };
            }
        }, {
            body: t.Object({ model: t.String(), rrp: t.Number() })
        })
        .post('/submit-application', async ({ body }: { body: any }) => {
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
                to: process.env.GMAIL_BOSS,
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
