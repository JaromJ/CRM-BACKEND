require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

/* ================= ADMIN SETUP ================= */

// Run once
app.post("/setup-admin", async (req, res) => {
  try {
    const existing = await prisma.admin.findFirst();

    if (existing) {
      return res.status(400).json({ message: "Admin already exists" });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email & password required" });
    }

    const hash = await bcrypt.hash(password, 10);

    const admin = await prisma.admin.create({
      data: { email, password: hash }
    });

    res.json(admin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) return res.status(400).json({ message: "Invalid email" });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(400).json({ message: "Invalid password" });

    const token = jwt.sign(
      { adminId: admin.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



/* ================= AUTH ================= */

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.adminId = decoded.adminId;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};

/* ================= HELPER ================= */

const getBalance = async (accountId) => {
  const incoming = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { toAccountId: accountId }
  });

  const outgoing = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { fromAccountId: accountId }
  });

  return (incoming._sum.amount || 0) - (outgoing._sum.amount || 0);
};


/* ================= PROFILE ================= */

// // Get logged-in admin profile
app.get("/profile", async (req, res) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: {
        id: req.adminId
      },
      select: {
        id: true,
        email: true,
      }
    });

    if (!admin) {
      return res.status(404).json({
        message: "Admin not found"
      });
    }

    res.json(admin);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* ================= CATEGORY ================= */

// Create
app.post("/categories", auth, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name ) {
      return res.status(400).json({ message: "Name required" });
    }

    const category = await prisma.category.create({
      data: { name}
    });

    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get
app.get("/categories", auth, async (req, res) => {
  const data = await prisma.category.findMany({
    orderBy: { createdAt: "desc" }
  });
  res.json(data);
});

// Update
app.put("/categories/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name } = req.body;

    const updated = await prisma.category.update({
      where: { id },
      data: { name }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete
app.delete("/categories/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await prisma.category.delete({ where: { id } });

    res.json({ message: "Category deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= ACCOUNT ================= */

// Create
app.post("/accounts", auth, async (req, res) => {
  try {
    const { name, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({ message: "Name & type required" });
    }

    const account = await prisma.account.create({
      data: { name, type }
    });

    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get with balance
app.get("/accounts", auth, async (req, res) => {
  const accounts = await prisma.account.findMany();

  const result = await Promise.all(
    accounts.map(async (acc) => {
      const balance = await getBalance(acc.id);
      return { ...acc, balance };
    })
  );

  res.json(result);
});

// Update
app.put("/accounts/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type } = req.body;

    const updated = await prisma.account.update({
      where: { id },
      data: { name, type }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete (safe)
app.delete("/accounts/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const tx = await prisma.transaction.findFirst({
      where: {
        OR: [
          { fromAccountId: id },
          { toAccountId: id }
        ]
      }
    });

    if (tx) {
      return res.status(400).json({
        message: "Cannot delete account with transactions"
      });
    }

    await prisma.account.delete({ where: { id } });

    res.json({ message: "Account deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= TRANSACTION ================= */

// Create
app.post("/transactions", auth, async (req, res) => {
  try {
    const {
      amount,
      type,
      fromAccountId,
      toAccountId,
      categoryId,
      categoryName,
      note
    } = req.body;

    if (!amount || !type) {
      return res.status(400).json({ message: "Amount & type required" });
    }

    // TYPE RULES
    if (type === "INCOME" && !toAccountId) {
      return res.status(400).json({ message: "INCOME needs toAccountId" });
    }

    if (type === "EXPENSE" && !fromAccountId) {
      return res.status(400).json({ message: "EXPENSE needs fromAccountId" });
    }

    if (type === "TRANSFER" && (!fromAccountId || !toAccountId)) {
      return res.status(400).json({ message: "TRANSFER needs both accounts" });
    }

    // 🔥 CATEGORY LOGIC
    let finalCategoryId = categoryId;

    if (!finalCategoryId && categoryName) {
      const existingCategory = await prisma.category.findFirst({
        where: { name: categoryName }
      });

      if (existingCategory) {
        finalCategoryId = existingCategory.id;
      } else {
        const newCategory = await prisma.category.create({
          data: {
            name: categoryName
          }
        });

        finalCategoryId = newCategory.id;
      }
    }

    // BALANCE CHECK
    if (fromAccountId) {
      const balance = await getBalance(fromAccountId);

      if (balance < amount) {
        return res.status(400).json({
          message: "Insufficient balance"
        });
      }
    }

    const tx = await prisma.transaction.create({
      data: {
        amount,
        type,
        fromAccountId,
        toAccountId,
        categoryId: finalCategoryId,
        note
      }
    });

    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get
app.get("/transactions", auth, async (req, res) => {
  const data = await prisma.transaction.findMany({
    include: {
      fromAccount: true,
      toAccount: true,
      category: true
    },
    orderBy: { createdAt: "desc" }
  });

  res.json(data);
});

app.put("/transactions/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const existing = await prisma.transaction.findUnique({
      where: { id }
    });

    if (!existing) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const {
      amount,
      type,
      fromAccountId,
      toAccountId,
      categoryId,
      note
    } = req.body;

    // 🧠 TYPE RULES
    if (type === "INCOME" && !toAccountId) {
      return res.status(400).json({ message: "INCOME needs toAccountId" });
    }

    if (type === "EXPENSE" && !fromAccountId) {
      return res.status(400).json({ message: "EXPENSE needs fromAccountId" });
    }

    if (type === "TRANSFER" && (!fromAccountId || !toAccountId)) {
      return res.status(400).json({
        message: "TRANSFER needs both accounts"
      });
    }

    // 🔒 BALANCE CHECK (important)
    if (fromAccountId) {
      const balance = await getBalance(fromAccountId);

      // add back old amount if same account
      const adjustedBalance =
        fromAccountId === existing.fromAccountId
          ? balance + existing.amount
          : balance;

      if (adjustedBalance < amount) {
        return res.status(400).json({
          message: "Insufficient balance after edit"
        });
      }
    }

    const updated = await prisma.transaction.update({
      where: { id },
      data: {
        amount,
        type,
        fromAccountId,
        toAccountId,
        categoryId,
        note
      }
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/transactions/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const existing = await prisma.transaction.findUnique({
      where: { id }
    });

    if (!existing) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    await prisma.transaction.delete({
      where: { id }
    });

    res.json({ message: "Transaction deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= ACCOUNT SUMMARY ================= */

app.get("/accounts/:id/summary", auth, async (req, res) => {
  const id = parseInt(req.params.id);

  const incoming = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { toAccountId: id }
  });

  const outgoing = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { fromAccountId: id }
  });

  const balance =
    (incoming._sum.amount || 0) - (outgoing._sum.amount || 0);

  res.json({
    incoming: incoming._sum.amount || 0,
    outgoing: outgoing._sum.amount || 0,
    balance
  });
});

/* ================= DASHBOARD ================= */

app.get("/dashboard", auth, async (req, res) => {
  try {
    // total income
    const totalIncome = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        type: "INCOME"
      }
    });

    // total expense
    const totalExpense = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        type: "EXPENSE"
      }
    });

    // total transfer
    const totalTransfer = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        type: "TRANSFER"
      }
    });

    // all accounts
    const accounts = await prisma.account.findMany();

    // calculate account balances
    const accountBalances = await Promise.all(
      accounts.map(async (acc) => {
        const incoming = await prisma.transaction.aggregate({
          _sum: { amount: true },
          where: {
            toAccountId: acc.id
          }
        });

        const outgoing = await prisma.transaction.aggregate({
          _sum: { amount: true },
          where: {
            fromAccountId: acc.id
          }
        });

        const balance =
          (incoming._sum.amount || 0) -
          (outgoing._sum.amount || 0);

        return {
          id: acc.id,
          name: acc.name,
          type: acc.type,
          balance
        };
      })
    );

    // total balance
    const totalBalance = accountBalances.reduce(
      (sum, acc) => sum + acc.balance,
      0
    );

    // recent transactions
    const recentTransactions =
      await prisma.transaction.findMany({
        take: 5,
        orderBy: {
          createdAt: "desc"
        },
        include: {
          fromAccount: true,
          toAccount: true,
          category: true
        }
      });

    // expense by category
    const expenseByCategory = await prisma.transaction.groupBy({
      by: ["categoryId"],
      where: {
        type: "EXPENSE"
      },
      _sum: {
        amount: true
      }
    });

    const categoryIds = expenseByCategory
      .map((item) => item.categoryId)
      .filter(Boolean);

    const categories = await prisma.category.findMany({
      where: {
        id: {
          in: categoryIds
        }
      }
    });

    const formattedExpenseCategory = expenseByCategory.map(
      (item) => ({
        categoryId: item.categoryId,
        categoryName:
          categories.find(
            (c) => c.id === item.categoryId
          )?.name || "Unknown",
        total: item._sum.amount || 0
      })
    );

    // monthly transactions summary
    const monthlyTransactions =
      await prisma.transaction.findMany({
        select: {
          amount: true,
          type: true,
          createdAt: true
        }
      });

    const monthlySummary = {};

    monthlyTransactions.forEach((tx) => {
      const month = new Date(tx.createdAt)
        .toISOString()
        .slice(0, 7); // YYYY-MM

      if (!monthlySummary[month]) {
        monthlySummary[month] = {
          income: 0,
          expense: 0
        };
      }

      if (tx.type === "INCOME") {
        monthlySummary[month].income += tx.amount;
      }

      if (tx.type === "EXPENSE") {
        monthlySummary[month].expense += tx.amount;
      }
    });

    res.json({
      summary: {
        totalBalance,
        totalIncome: totalIncome._sum.amount || 0,
        totalExpense: totalExpense._sum.amount || 0,
        totalTransfer: totalTransfer._sum.amount || 0
      },

      accounts: accountBalances,

      recentTransactions,

      expenseByCategory: formattedExpenseCategory,

      monthlySummary
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});