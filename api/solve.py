from flask import Flask, request, jsonify
import sympy as sp

app = Flask(__name__)

@app.route('/api/solve', methods=['POST'])
def solve_math():
    try:
        data = request.get_json()
        expression = data.get('expression', '')
        operation = data.get('operation', 'simplify') # Options: simplify, solve, integrate, derive
        variable = data.get('variable', 'x')

        if not expression:
            return jsonify({"error": "Expression is missing"}), 400

        # Convert string to mathematical object
        expr = sp.sympify(expression)
        var = sp.Symbol(variable)
        
        result = None

        # Perform the actual hardcore math
        if operation == 'integrate':
            result = sp.integrate(expr, var)
        elif operation == 'derive':
            result = sp.diff(expr, var)
        elif operation == 'solve':
            result = sp.solve(expr, var) # Solves expression = 0
        else:
            result = sp.simplify(expr)

        # Convert result directly to strictly formatted LaTeX
        latex_result = sp.latex(result)

        return jsonify({
            "success": True, 
            "operation": operation,
            "latex": f"$$ {latex_result} $$",
            "raw_answer": str(result)
        })

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

# Required for Vercel Python Serverless
def handler(request, response):
    return app(request, response)
